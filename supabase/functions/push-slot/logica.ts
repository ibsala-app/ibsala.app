// push-slot, a parte que dá pra testar: paginação, lote de inscrições, fila de
// envio e o dedupe por código.
//
// Mora fora do `index.ts` porque `Deno.serve` no topo do módulo sobe um servidor
// no instante em que o arquivo é importado, e teste que importa servidor vaza
// recurso e não fecha. Aqui não há efeito de módulo nenhum: `rest` e `enviar`
// entram por parâmetro, então o teste passa um `fetch` de mentira e mede o
// comportamento em 1.500 matérias sem tocar em produção.

import { slotDoInicio } from '../_shared/slots.ts'

export type Rest = (path: string, init?: RequestInit) => Promise<any>
export type Resultado = 'enviado' | 'morta' | 'falha'
export type Inscricao = { endpoint: string; p256dh: string; auth: string; aluno_id: string }
export type Enviar = (s: Inscricao, payload: unknown) => Promise<Resultado>

/** Teto de linhas por resposta. É o `db.max_rows` do Supabase, que vale para
 *  todo projeto que não mexeu nisso. */
export const PAGINA = 1000
/** Ids de aluno por URL. 100 uuids dão ~3,7 KB de query string; os 1.000 de uma
 *  vez passavam de 37 KB e o PostgREST responde 414. */
export const LOTE_IDS = 100
/** Envios simultâneos. */
export const CONCORRENCIA = 20

const quando = (r: any) => Date.parse(r?.capturado ?? '') || 0

/** Varre a tabela inteira em páginas por chave.
 *
 *  O PostgREST corta em `db.max_rows` sem avisar: devolve 200 com a primeira
 *  página e o resto some. Com 30 alunos isso nunca apareceu; com 1.000 o corte
 *  cai no meio das matérias e quem ficou na segunda página não recebe aviso
 *  nenhum, sem erro em log nenhum.
 *
 *  Por chave e não por offset: offset relê linha já lida e pula linha nova
 *  quando uma escrita entra no meio da varredura, e a captura escreve em
 *  `mapa_dia` a cada 30 minutos. */
export async function paginar(
  rest: Rest, caminho: string, pagina = PAGINA,
): Promise<any[]> {
  const tudo: any[] = []
  let ultimo = 0
  // teto de voltas: 200 páginas são 200 mil linhas, ordens de grandeza acima de
  // qualquer dia real. Existe para o caso de a resposta vir sem `id`, que sem
  // isto viraria laço infinito dentro da edge function
  for (let volta = 0; volta < 200; volta++) {
    const sep = caminho.includes('?') ? '&' : '?'
    const parte: any[] = await rest(
      `${caminho}${sep}id=gt.${ultimo}&order=id.asc&limit=${pagina}`)
    tudo.push(...parte)
    if (parte.length < pagina) break
    const fim = parte[parte.length - 1]?.id
    if (typeof fim !== 'number') break
    ultimo = fim
  }
  return tudo
}

/** Inscrições de um lote de alunos.
 *
 *  `push_subscriptions` tem o endpoint como chave primária e nenhuma coluna
 *  numérica, então a paginação por id não serve aqui. O tamanho do lote já
 *  limita a URL; resposta cheia é suspeita de corte, e aí o lote se parte no
 *  meio até caber. */
export async function subsDe(rest: Rest, ids: string[], pagina = PAGINA): Promise<any[]> {
  if (!ids.length) return []
  const linhas: any[] = await rest(
    `push_subscriptions?aluno_id=in.(${ids.join(',')})` +
    `&select=endpoint,p256dh,auth,aluno_id&limit=${pagina}`)
  if (linhas.length < pagina || ids.length === 1) return linhas
  const meio = Math.ceil(ids.length / 2)
  const [a, b] = await Promise.all([
    subsDe(rest, ids.slice(0, meio), pagina),
    subsDe(rest, ids.slice(meio), pagina),
  ])
  return [...a, ...b]
}

/** Todas as inscrições dos alunos com aula, sem endpoint repetido. */
export async function todasAsSubs(
  rest: Rest, ids: string[], pagina = PAGINA,
): Promise<Inscricao[]> {
  const vistos = new Set<string>()
  const subs: Inscricao[] = []
  for (let i = 0; i < ids.length; i += LOTE_IDS) {
    for (const s of await subsDe(rest, ids.slice(i, i + LOTE_IDS), pagina)) {
      if (vistos.has(s.endpoint)) continue
      vistos.add(s.endpoint)
      subs.push(s)
    }
  }
  return subs
}

/** Fila com N trabalhadores.
 *
 *  O `Promise.all` cru abria uma conexão por inscrição ao mesmo tempo: com 1.000
 *  alunos são milhares de requisições simultâneas para o mesmo push service, que
 *  responde 429 e leva envio bom junto. */
export async function emLotes<T>(
  itens: T[], n: number, fn: (t: T) => Promise<void>,
): Promise<void> {
  let proximo = 0
  const trabalhador = async () => {
    while (proximo < itens.length) await fn(itens[proximo++])
  }
  const quantos = Math.max(1, Math.min(n, itens.length))
  await Promise.all(Array.from({ length: quantos }, trabalhador))
}

/** Uma aula por código, a mais recente.
 *
 *  Era `order=capturado.desc` mais "fica a primeira que aparecer", o que só vale
 *  enquanto a resposta cabe numa página. Com a varredura ordenada por `id`, quem
 *  decide passa a ser a comparação explícita de `capturado`: sem isso o aluno
 *  voltaria a ser mandado para a sala ANTIGA, que é o defeito que a ordenação
 *  tinha consertado. */
export function maisRecentePorCodigo(linhas: any[]): Map<string, any> {
  const por = new Map<string, any>()
  for (const r of linhas) {
    const atual = por.get(r.codigo)
    if (!atual || quando(r) > quando(atual) ||
        (quando(r) === quando(atual) && (r.id ?? 0) > (atual.id ?? 0))) {
      por.set(r.codigo, r)
    }
  }
  return por
}

export type Saida = {
  enviados: number
  falhas: number
  limpas: number
  alunos: number
  subs: number
  motivo?: string
}

/** O corpo do push-slot, com rede e envio injetados. */
export async function executar(dep: {
  rest: Rest
  enviar: Enviar
  slot: string
  iso: string
  diaSemana: number
  concorrencia?: number
}): Promise<Saida> {
  const { rest, enviar, slot, iso, diaSemana, concorrencia = CONCORRENCIA } = dep
  const vazio = { enviados: 0, falhas: 0, limpas: 0, alunos: 0, subs: 0 }

  // `sala_canon` e não `sala`: o rótulo cru da planilha ia inteiro pro título da
  // notificação ("Sala 207 (P2) LAB.PROJETOS ELETRICOS/206 (P2)"), e pseudo-sala
  // como CANCELADA e ONLINE, que tem canônica nula de propósito justamente pra
  // não ocupar nada, chegava no aluno como "Sala CANCELADA".
  const mapa = await paginar(rest, `mapa_dia?data=eq.${iso}` +
    `&select=id,codigo,disciplina,horario,professor,sala_canon,capturado`)
  const doSlot = mapa.filter((r) =>
    r.codigo && r.sala_canon && slotDoInicio(r.horario) === slot)
  if (!doSlot.length) return { ...vazio, motivo: 'mapa vazio no slot' }
  const porCodigo = maisRecentePorCodigo(doSlot)

  const materias = await paginar(rest, `materias?dia=eq.${diaSemana}` +
    '&select=id,aluno_id,codigo,disciplina,alunos!inner(bloqueado)' +
    '&alunos.bloqueado=eq.false')

  const porAluno = new Map<string, any[]>()
  for (const m of materias) {
    const aula = porCodigo.get(m.codigo)
    if (!aula) continue
    if (!porAluno.has(m.aluno_id)) porAluno.set(m.aluno_id, [])
    porAluno.get(m.aluno_id)!.push(aula)
  }
  if (!porAluno.size) return { ...vazio, motivo: 'ninguém com aula' }

  const subs = await todasAsSubs(rest, [...porAluno.keys()])

  let enviados = 0
  let limpas = 0
  let falhas = 0
  await emLotes(subs, concorrencia, async (s) => {
    const aulas = porAluno.get(s.aluno_id)
    if (!aulas) return
    const salas = [...new Set(aulas.map((a) => a.sala_canon))]
    const titulo = salas.length === 1 ? `Sala ${salas[0]}` : `Salas ${salas.join(', ')}`
    const corpo = aulas.map((a) =>
      `${a.disciplina} · ${(a.professor || '').split(' ')[0]} · ${a.horario}`).join('\n')
    const r = await enviar(s, { title: titulo, body: corpo, tag: `ibsala-${slot}` })
    if (r === 'enviado') {
      enviados++
    } else if (r === 'morta') {
      // inscrição morta: limpa. O DELETE dentro de um Promise.all sem catch
      // derrubava a resposta inteira DEPOIS dos pushes já terem saído
      try {
        await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`,
          { method: 'DELETE' })
        limpas++
      } catch { /* some na próxima rodada */ }
    } else {
      falhas++
    }
  })

  return { enviados, falhas, limpas, alunos: porAluno.size, subs: subs.length }
}
