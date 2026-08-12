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

import repertorioJson from '../_shared/salas-repertorio.json' with { type: 'json' }

const URL_BASE = Deno.env.get('SUPABASE_URL')!
const KEY = Deno.env.get('SERVICE_KEY')!

const SPREADSHEET_ID = '1-TyWurlvjDaiGwRmNFlq3OyK8ia4UP3fPpiSxyL2d3Y'
const EXPORT_URL =
  `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv`

const TITULOS_CATEGORIA = [
  'GRADUAÇÃO - MANHÃ',
  'GRADUAÇÃO - TARDE',
  'GRADUAÇÃO - NOITE',
  'OUTRAS RESERVAS - NOITE',
]

// ── normalização ─────────────────────────────────────────────────────────────

function semAcento(texto: unknown): string {
  return String(texto ?? '').normalize('NFD').replace(/\p{Mn}/gu, '').trim()
}

/** Chave de casamento: sem acento, SEM pontuação, espaço colapsado, maiúscula.
 *  A barra sobrevive de propósito: resolverSala depende dela. */
function chave(texto: unknown): string {
  return semAcento(texto).toUpperCase().replace(/[().\-]/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

function extrairCodigo(texto: unknown): [string, string] {
  const s = String(texto ?? '')
  if (s.includes('/')) {
    const i = s.indexOf('/')
    return [s.slice(0, i).trim(), s.slice(i + 1).trim()]
  }
  return ['', s.trim()]
}

// ── repertório ───────────────────────────────────────────────────────────────

type Repertorio = {
  salas: Map<string, string>
  predio: Record<string, string>
  apelidos: Map<string, string>
  ignoradas: Set<string>
}

function carregarRepertorio(rep = repertorioJson as any): Repertorio {
  // com chave insensível a pontuação dois rótulos podem colapsar; se apontarem
  // pra salas diferentes é ambiguidade silenciosa, e é melhor morrer aqui
  const visto = new Map<string, [string, string, string | null]>()
  const registrar = (rotulo: string, canon: string | null, origem: string) => {
    const k = chave(rotulo)
    const anterior = visto.get(k)
    if (anterior && anterior[2] !== canon) {
      throw new Error(
        `repertório ambíguo: a chave "${k}" sai de ${anterior[0]} ` +
        `"${anterior[1]}" -> ${anterior[2]} e de ${origem} "${rotulo}" -> ${canon}`)
    }
    visto.set(k, [origem, rotulo, canon])
    return k
  }

  const salas = new Map<string, string>()
  const apelidos = new Map<string, string>()
  const ignoradas = new Set<string>()
  for (const s of Object.keys(rep.salas)) salas.set(registrar(s, s, 'canonica'), s)
  for (const [a, c] of Object.entries(rep.apelidos)) {
    apelidos.set(registrar(a, c as string, 'apelido'), c as string)
  }
  for (const i of rep.ignoradas) ignoradas.add(registrar(i, null, 'ignorada'))

  return { salas, predio: { ...rep.salas }, apelidos, ignoradas }
}

function ladosDaBarra(bruta: string, rep: Repertorio): string[] {
  const achadas: string[] = []
  for (const parte of String(bruta).split('/')) {
    const k = chave(parte)
    if (rep.salas.has(k)) achadas.push(rep.salas.get(k)!)
    else if (rep.apelidos.has(k)) achadas.push(rep.apelidos.get(k)!)
  }
  return [...new Set(achadas)]
}

function resolverSala(bruta: unknown, rep: Repertorio): [string | null, string] {
  const k = chave(bruta)
  if (!k) return [null, 'vazia']
  if (rep.ignoradas.has(k)) return [null, 'ignorada']
  if (rep.salas.has(k)) return [rep.salas.get(k)!, 'canonica']
  if (rep.apelidos.has(k)) return [rep.apelidos.get(k)!, 'apelido']
  if (k.includes('/')) {
    const lados = ladosDaBarra(String(bruta), rep)
    if (lados.length === 1) return [lados[0], 'apelido-barra']
    if (lados.length > 1) return [null, 'barra-multipla']
    return [null, 'ignorada']
  }
  return [null, 'desconhecida']
}

function anotarCanonicas(linhas: any[], rep: Repertorio) {
  const pendentes: Record<string, number> = {}
  const multiplas: Record<string, string[]> = {}
  for (const l of linhas) {
    const bruta = String(l.sala ?? '').trim()
    const [canon, motivo] = resolverSala(bruta, rep)
    l.sala_canon = canon
    if (motivo === 'desconhecida') pendentes[bruta] = (pendentes[bruta] ?? 0) + 1
    else if (motivo === 'barra-multipla') multiplas[bruta] = ladosDaBarra(bruta, rep)
  }
  return { pendentes, multiplas }
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/** CSV do export do Google: campo entre aspas, aspas dobradas, CRLF ou LF.
 *  Escrito à mão pra não depender de import externo no caminho do cron. */
function lerCsv(texto: string): string[][] {
  const linhas: string[][] = []
  let campo = ''
  let linha: string[] = []
  let dentroDeAspas = false
  const t = texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto   // BOM

  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (dentroDeAspas) {
      if (c === '"') {
        if (t[i + 1] === '"') { campo += '"'; i++ } else dentroDeAspas = false
      } else campo += c
      continue
    }
    if (c === '"') { dentroDeAspas = true; continue }
    if (c === ',') { linha.push(campo); campo = ''; continue }
    if (c === '\r') continue
    if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; continue }
    campo += c
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha) }
  return linhas
}

function hojeISO(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' })
}

/** Replica parsear() do Python: seções por título de categoria, linha-header
 *  começando em "Turma", valores até a próxima seção. */
function parsear(textoCsv: string): any[] {
  const registros: Record<string, string>[] = []
  let categoria: string | null = null
  let colunas: string[] | null = null

  for (const valores of lerCsv(textoCsv)) {
    const col0 = (valores[0] ?? '').trim()
    const restoVazio = valores.slice(1).every((v) => !v.trim())

    if (TITULOS_CATEGORIA.includes(col0) && restoVazio) {
      categoria = col0
      colunas = null
      continue
    }
    if (col0 === 'Turma' && categoria) {
      colunas = valores.map((v, i) => (v.trim() ? semAcento(v) : `col${i}`))
      continue
    }
    if (categoria && colunas && col0 && col0 !== 'nan') {
      const vals = [...valores]
      while (vals.length < colunas.length) vals.push('')
      const reg: Record<string, string> = { Categoria: categoria }
      colunas.forEach((col, i) => { reg[col] = (vals[i] ?? '').trim() })
      if (Object.entries(reg).some(([k, v]) => k !== 'Categoria' && v)) registros.push(reg)
    }
  }

  // coluna de horário costuma vir sem header ("colN"); primeira vazia vira Horario
  for (const reg of registros) {
    if (!('Horario' in reg)) {
      for (const k of Object.keys(reg)) {
        if (k.startsWith('col')) { reg.Horario = reg[k]; delete reg[k]; break }
      }
    }
  }

  const hoje = hojeISO()
  const linhas: any[] = []
  for (const reg of registros) {
    // linha sem disciplina e sem horário não é aula (título perdido, subtotal)
    if (!(reg.Disciplina ?? '').trim() && !(reg.Horario ?? '').trim()) continue
    const [codigo, disciplina] = extrairCodigo(reg.Disciplina ?? '')
    linhas.push({
      data: hoje,
      categoria: reg.Categoria,
      turma: reg.Turma ?? '',
      codigo,
      disciplina,
      horario: reg.Horario ?? '',
      professor: reg.Professor ?? '',
      sala: reg.Salas ?? reg.Sala ?? '',
    })
  }
  return linhas
}

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

async function enviar(linhas: any[], rep: Repertorio, pendentes: Record<string, number>) {
  await post('mapa_dia', linhas, 'data,merge_key', 'merge-duplicates')

  const disc = new Map<string, any>()
  for (const l of linhas) {
    if (l.codigo) {
      disc.set(l.codigo, {
        codigo: l.codigo, turma: l.turma,
        disciplina: l.disciplina, professor: l.professor,
      })
    }
  }
  if (disc.size) {
    await post('disciplinas_historico', [...disc.values()], 'codigo', 'merge-duplicates')
  }

  // o repertório manda: sala nova nasce no JSON, não no que a planilha cospe
  await post('salas',
    Object.entries(rep.predio).map(([sala, predio]) => ({ sala, predio })),
    'sala', 'ignore-duplicates')

  // grafia fora do repertório espera revisão humana. visto_em entra no payload
  // porque sem ele a coluna guarda o primeiro avistamento pra sempre
  const alias = Object.entries(pendentes)
  if (alias.length) {
    const agora = new Date().toISOString()
    await post('salas_pendentes',
      alias.map(([a, n]) => ({ alias: a, ocorrencias: n, visto_em: agora })),
      'alias', 'merge-duplicates')
  }
}

/** Marca de frescor lida pelo front. net.http_post do pg_cron é fire and
 *  forget: sem isto, agendador parado é invisível. */
async function marcarFrescor(resumo: unknown) {
  await post('config', [{ key: 'ultima_captura', value: resumo }], 'key', 'merge-duplicates')
}

// ── handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) {
    return new Response('nope', { status: 401 })
  }
  const corpo = await req.json().catch(() => ({})) as { dry?: boolean; csv?: string }

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

  await enviar(linhas, rep, pendentes)
  await marcarFrescor(resumo)
  return Response.json({ ...resumo, pendentes, multiplas })
})
