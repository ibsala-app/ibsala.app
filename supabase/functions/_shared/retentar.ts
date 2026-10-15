// Repetição limitada das consultas ao PostgREST. 401 é recusa antes da
// execução e pode repetir qualquer método. Rede e 5xx só repetem leituras:
// uma escrita pode ter sido aplicada antes de a resposta se perder.

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
    /** RPC POST que apenas consulta dados; nunca marcar claim ou envio. */
    leitura?: boolean
  } = {},
): Promise<Response> {
  const { fetch: f = fetch, dormir = dormirDeVerdade, esperas = ESPERAS_MS } = dep
  const leitura = dep.leitura === true || ['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase())
  for (let i = 0; ; i++) {
    let r: Response
    try {
      r = await f(url, init)
    } catch (e) {
      if (!leitura || init.signal?.aborted || i >= esperas.length) throw e
      await dormir(esperas[i])
      if (init.signal?.aborted) throw e
      continue
    }
    const transitorio = r.status === 401 || (leitura && r.status >= 500 && r.status <= 599)
    if (!transitorio || init.signal?.aborted || i >= esperas.length) return r
    // corpo não lido segura a conexão aberta no runtime
    await r.body?.cancel()
    await dormir(esperas[i])
  }
}
