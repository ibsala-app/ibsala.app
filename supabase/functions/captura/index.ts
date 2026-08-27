// captura: planilha da universidade -> Supabase. Porte de capture/captura.py.
//
// Existe porque o schedule do GitHub Actions entrega 6 a 10 execuções por dia
// no lugar das 48 que o cron pede (throttle do lado do GitHub, medido em
// 03/08-12/08). O mapa_dia guarda só o dia corrente, então enquanto a primeira
// captura do dia não cai o app mostra salas livres demais e nenhuma aula: em
// 11/08 isso durou das 00:30 às 07:37 BRT, na abertura do turno da manhã.
// O pg_cron do Supabase já dispara os 6 pushes e o email-drain sem falhar.
//
// Deploy: supabase functions deploy captura --no-verify-jwt
// Secrets: CRON_SECRET, SUPABASE_URL, SERVICE_KEY
//
// Corpo aceito (tudo opcional):
//   {"dry": true}          não escreve nada, devolve o payload calculado
//   {"csv": "<texto>"}     usa esse CSV no lugar da planilha (portão de paridade)
//
// O portão de paridade (scripts/paridade-captura.py) manda o MESMO csv pro
// Python e pra cá e exige payload idêntico. É o que impede o porte de
// reintroduzir o defeito da 114.

import { segredoConfere } from '../_shared/cron.ts'
import { carregarRepertorio, type Repertorio } from '../_shared/repertorio.ts'
import { anotarCanonicas, parsear } from './logica.ts'

const URL_BASE = Deno.env.get('SUPABASE_URL')!
const KEY = Deno.env.get('SERVICE_KEY')!

const SPREADSHEET_ID = '1-TyWurlvjDaiGwRmNFlq3OyK8ia4UP3fPpiSxyL2d3Y'
const EXPORT_URL =
  `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv`



// ── escrita ──────────────────────────────────────────────────────────────────

async function post(tabela: string, payload: unknown, onConflict: string, resolution: string) {
  const r = await fetch(`${URL_BASE}/rest/v1/${tabela}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: `resolution=${resolution}`,
    },
    body: JSON.stringify(payload),
  })
  if (!r.ok) throw new Error(`${tabela}: ${r.status} ${await r.text()}`)
}

/** Chave do `merge_key` gerado pelo banco (0001): md5 dos 6 campos, sem a sala.
 *  Duas linhas da planilha iguais nesses 6 campos e diferentes só na sala fazem
 *  o Postgres levantar 21000 ("ON CONFLICT DO UPDATE command cannot affect row a
 *  second time"), e aí a rodada INTEIRA morre sem escrever nada. Como o
 *  net.http_post do pg_cron é fire and forget, ninguém veria: só a pill de
 *  frescor parando de andar. O v1 deduplicava no pandas (keep last) antes de
 *  escrever, e o porte perdeu isso. */
const chaveMerge = (l: any) =>
  [l.categoria, l.turma, l.codigo, l.disciplina, l.horario, l.professor]
    .map((v) => v ?? '').join('|')

/** Apaga o que a planilha não tem mais. `mapa_dia` só crescia durante o dia:
 *  como o merge_key inclui professor e horário, cada edição da planilha criava
 *  linha nova e a velha só saía às 00:30. Em 12/08 eram 182 linhas no banco
 *  contra 105 na planilha, e o efeito na tela era sala aparecendo ocupada com
 *  ninguém dentro (26 pares sala/slot, 8 deles no 1º noite).
 *
 *  Só é seguro porque agora `capturado` vai no payload do upsert: sem isso o
 *  merge do PostgREST não toca a coluna, linha viva mantém o timestamp do
 *  primeiro avistamento, e o delete comeria dado bom. Escopo é sempre o dia
 *  corrente. Rodada concorrente sobrevive: ela grava capturado maior que este. */
async function apagarFantasmas(dia: string, inicio: string): Promise<number> {
  const url = `${URL_BASE}/rest/v1/mapa_dia?select=id&data=eq.${dia}` +
    `&capturado=lt.${encodeURIComponent(inicio)}`
  const r = await fetch(url, {
    method: 'DELETE',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      Prefer: 'return=representation',
    },
  })
  if (!r.ok) throw new Error(`mapa_dia delete: ${r.status} ${await r.text()}`)
  return ((await r.json()) as unknown[]).length
}

async function enviar(linhas: any[], rep: Repertorio, pendentes: Record<string, number>) {
  const inicio = new Date().toISOString()

  const porChave = new Map<string, any>()
  for (const l of linhas) porChave.set(chaveMerge(l), l)   // keep last, como o v1
  const unicas = [...porChave.values()].map((l) => ({ ...l, capturado: inicio }))

  await post('mapa_dia', unicas, 'data,merge_key', 'merge-duplicates')
  const apagadas = await apagarFantasmas(unicas[0].data, inicio)

  const disc = new Map<string, any>()
  for (const l of linhas) {
    if (l.codigo) {
      disc.set(l.codigo, {
        codigo: l.codigo, turma: l.turma,
        disciplina: l.disciplina, professor: l.professor,
        // sem isto a coluna se chama `atualizado` e guarda `criado`: o merge do
        // PostgREST só toca coluna que está no payload
        atualizado: inicio,
      })
    }
  }
  if (disc.size) {
    await post('disciplinas_historico', [...disc.values()], 'codigo', 'merge-duplicates')
  }

  // o repertório manda: sala nova nasce no JSON, não no que a planilha cospe.
  // `merge-duplicates` e não `ignore`: com ignore, corrigir o prédio de uma sala
  // no JSON nunca chegava no banco (a 0006 precisou de UPDATE à mão pra isso)
  await post('salas',
    Object.entries(rep.predio).map(([sala, predio]) => ({ sala, predio })),
    'sala', 'merge-duplicates')

  // grafia fora do repertório espera revisão humana. visto_em entra no payload
  // porque sem ele a coluna guarda o primeiro avistamento pra sempre
  const alias = Object.entries(pendentes)
  if (alias.length) {
    await post('salas_pendentes',
      alias.map(([a, n]) => ({ alias: a, ocorrencias: n, visto_em: inicio })),
      'alias', 'merge-duplicates')
  }

  return { apagadas, duplicadas: linhas.length - unicas.length }
}

/** Marca de frescor lida pelo front. net.http_post do pg_cron é fire and
 *  forget: sem isto, agendador parado é invisível. */
async function marcarFrescor(resumo: unknown) {
  await post('config', [{ key: 'ultima_captura', value: resumo }], 'key', 'merge-duplicates')
}

// ── handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (!await segredoConfere(req)) return new Response('nope', { status: 401 })
  const corpo = await req.json().catch(() => ({})) as { dry?: boolean; csv?: string }

  // o campo `csv` existe só pro portão de paridade, que sempre manda dry: true.
  // Fora do dry ele seria injeção de mapa inteiro no banco por quem tivesse o
  // segredo do cron.
  if (corpo.csv && !corpo.dry) {
    return new Response('csv só é aceito em modo dry', { status: 400 })
  }

  const texto = corpo.csv ?? await (async () => {
    const r = await fetch(EXPORT_URL, { headers: { 'User-Agent': 'ibsala-captura/2.0' } })
    if (!r.ok) throw new Error(`planilha: ${r.status}`)
    return r.text()
  })()

  const linhas = parsear(texto)
  if (!linhas.length) {
    // estado legítimo em férias e fim de semana: a planilha da fonte fica vazia
    return Response.json({ linhas: 0, motivo: 'planilha vazia' })
  }

  const rep = carregarRepertorio()
  const { pendentes, multiplas } = anotarCanonicas(linhas, rep)
  const ocupando = linhas.filter((l) => l.sala_canon).length

  const disc = [...new Set(linhas.filter((l) => l.codigo).map((l) => l.codigo))]
  const resumo = {
    em: new Date().toISOString(),
    linhas: linhas.length,
    ocupando,
    quarentena: Object.keys(pendentes).length,
  }

  if (corpo.dry) {
    return Response.json({ ...resumo, dry: true, linhas_detalhe: linhas, disciplinas: disc.sort(), pendentes, multiplas })
  }

  const escrita = await enviar(linhas, rep, pendentes)
  const completo = { ...resumo, ...escrita }
  await marcarFrescor(completo)
  return Response.json({ ...completo, pendentes, multiplas })
})
