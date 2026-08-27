// captura-pos: planilha da coordenação da pós -> Supabase, em tabela própria.
//
// Separada da `captura` de propósito: a fonte é outra planilha, com outro
// formato, e a limpeza de uma NUNCA pode alcançar as linhas da outra. Ver o
// cabeçalho da migration 0019.
//
// Deploy: supabase functions deploy captura-pos --no-verify-jwt
// Secrets: CRON_SECRET, SUPABASE_URL, SERVICE_KEY (os mesmos da captura)
//
// Corpo aceito (tudo opcional):
//   {"dry": true}          não escreve nada, devolve o que leu
//   {"csv": "<texto>"}     usa esse CSV no lugar da planilha (só em dry)
//
// Estado degradado (cabeçalho diferente, resposta que não é CSV, data ilegível,
// rede fora) preserva o último lote bom e fica registrado em
// `config.ultima_captura_pos`. Fonte estranha não apaga nada.

import { segredoConfere } from '../_shared/cron.ts'
import { analisar } from './logica.ts'

const URL_BASE = Deno.env.get('SUPABASE_URL')!
const KEY = Deno.env.get('SERVICE_KEY')!

const PLANILHA = '1FVjxFLKgUC2U8GX2X3vgOeoDPt1Kx0wvOZHDgQk8KXk'
const EXPORT_URL = `https://docs.google.com/spreadsheets/d/${PLANILHA}/export?format=csv`
const TETO_MS = 20_000
// a fonte inteira tinha 268 bytes em 27/08; 2 MiB é folga de quatro ordens de
// grandeza e ainda impede que uma página de erro gigante entre na função
const TETO_BYTES = 2 * 1024 * 1024

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  return r.status === 204 ? null : r.json()
}

async function marcar(resumo: Record<string, unknown>) {
  await rest('config?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{
      key: 'ultima_captura_pos',
      value: { em: new Date().toISOString(), ...resumo },
    }]),
  }).catch(() => {})
}

/** Baixa a planilha. Devolve o texto, ou o motivo do estado degradado. */
async function baixar(): Promise<{ texto: string } | { motivo: string }> {
  let r: Response
  try {
    r = await fetch(EXPORT_URL, {
      headers: { 'User-Agent': 'ibsala-captura-pos/1.0' },
      signal: AbortSignal.timeout(TETO_MS),
    })
  } catch {
    return { motivo: 'rede' }
  }
  if (!r.ok) return { motivo: `http-${r.status}` }

  // planilha que perdeu o compartilhamento público responde 200 com a PÁGINA DE
  // LOGIN do Google, em text/html. Sem esta checagem, o parser leria HTML como
  // CSV e o cabeçalho não bateria: daria degradado do mesmo jeito, mas pelo
  // motivo errado, e "conteudo-nao-csv" é o que manda avisar a coordenação
  const tipo = r.headers.get('content-type') ?? ''
  if (!tipo.includes('text/csv')) return { motivo: 'conteudo-nao-csv' }

  const tamanho = Number(r.headers.get('content-length') ?? 0)
  if (tamanho > TETO_BYTES) return { motivo: 'resposta-grande' }

  const texto = await r.text()
  if (texto.length > TETO_BYTES) return { motivo: 'resposta-grande' }
  return { texto }
}

Deno.serve(async (req) => {
  if (!await segredoConfere(req)) return new Response('nope', { status: 401 })
  const corpo = await req.json().catch(() => ({})) as { dry?: boolean; csv?: string }

  // fora do dry, `csv` seria injeção de lote inteiro por quem tivesse o segredo
  if (corpo.csv && !corpo.dry) {
    return new Response('csv só é aceito em modo dry', { status: 400 })
  }

  let texto: string
  if (corpo.csv) {
    texto = corpo.csv
  } else {
    const baixado = await baixar()
    if ('motivo' in baixado) {
      await marcar({ estado: 'degradado', motivo: baixado.motivo })
      return Response.json({ estado: 'degradado', motivo: baixado.motivo })
    }
    texto = baixado.texto
  }

  const analise = analisar(texto)
  if (analise.estado === 'degradado') {
    await marcar({ estado: 'degradado', motivo: analise.motivo })
    return Response.json(analise)
  }

  if (corpo.dry) return Response.json({ ...analise, dry: true })

  const batch = crypto.randomUUID()
  const escrita = await rest('rpc/substituir_lote_pos', {
    method: 'POST',
    body: JSON.stringify({
      linhas: analise.linhas, p_data: analise.data_fonte, p_batch: batch,
    }),
  })

  const resumo = {
    estado: 'ok',
    data_fonte: analise.data_fonte,
    linhas: analise.linhas.length,
    remotas: analise.linhas.filter((l) => l.modalidade === 'remoto').length,
    sem_sala_canonica: analise.linhas.filter((l) => !l.sala_canon).length,
    batch,
    ...(escrita ?? {}),
  }
  await marcar(resumo)
  return Response.json(resumo)
})
