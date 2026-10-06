// `fetch` pro PostgREST que não desiste no primeiro 401.
//
// Em 06/10/2026 o gateway do Supabase recusou a SERVICE_KEY duas vezes numa
// manhã: `captura-pos` às 06:00 (IBSALA-15) e `push-slot` às 06:40 (IBSALA-16).
// A chave estava certa: no mesmo segundo das 06:40 o `send-emails` passou com
// ela, e 80 leituras seguidas depois deram 80 vezes 200. Como o 401 caiu na
// primeira leitura do push-slot, a function morreu com 500 e o slot inteiro
// ficou sem aviso, porque o pg_cron não repete.
//
// Só 401 entra aqui. Ele é recusa na porta, antes de o banco executar qualquer
// coisa, então repetir vale pra GET, POST e DELETE sem risco de escrita em
// dobro. 5xx não tem essa garantia e continua subindo como erro.

/** Pausas entre as tentativas. Quatro tentativas em até 7,5 s: o pg_cron já não
 *  espera a resposta (net.http_post é fire and forget), então o custo é só o
 *  tempo de vida da function. */
export const ESPERAS_MS = [500, 2000, 5000]

const dormirDeVerdade = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms))

export async function buscar(
  url: string,
  init: RequestInit = {},
  dep: {
    fetch?: typeof fetch
    dormir?: (ms: number) => Promise<void>
    esperas?: number[]
  } = {},
): Promise<Response> {
  const { fetch: f = fetch, dormir = dormirDeVerdade, esperas = ESPERAS_MS } = dep
  for (let i = 0; ; i++) {
    const r = await f(url, init)
    if (r.status !== 401 || i >= esperas.length) return r
    // corpo não lido segura a conexão aberta no runtime
    await r.body?.cancel()
    await dormir(esperas[i])
  }
}
