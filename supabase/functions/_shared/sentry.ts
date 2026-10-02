// Sentry nas edge functions. Até aqui a única telemetria delas era o log do
// painel do Supabase, que ninguém abre: a captura podia degradar, o push podia
// falhar metade dos envios e o Resend podia segurar a fila dias inteiros sem
// nenhum aviso chegar a lugar nenhum.
//
// Mesmo projeto do front (ibsala-pp/ibsala), separado por `environment: edge` e
// pela tag `function`. Sem o secret SENTRY_DSN tudo aqui vira no-op e a function
// se comporta exatamente como antes:
//   supabase secrets set SENTRY_DSN=<dsn do projeto>
//
// `defaultIntegrations: false` é a recomendação do Supabase pro edge runtime:
// as integrações globais do Deno (unhandledrejection, contexto do processo) não
// fazem sentido num isolate que atende uma requisição e morre.

import * as Sentry from 'npm:@sentry/deno@10.75.3'

const DSN = Deno.env.get('SENTRY_DSN')
const ligado = !!DSN

if (ligado) {
  Sentry.init({
    dsn: DSN,
    environment: 'edge',
    defaultIntegrations: false,
    tracesSampleRate: 1.0,
    sendDefaultPii: false,
  })
  Sentry.setTag('region', Deno.env.get('SB_REGION') ?? 'desconhecida')
  Sentry.setTag('execution_id', Deno.env.get('SB_EXECUTION_ID') ?? 'desconhecido')
}

type Nivel = 'fatal' | 'error' | 'warning' | 'info' | 'debug'

/** Evento sem exceção: o caminho que responde 200 mas não fez o trabalho. */
export function avisar(msg: string, nivel: Nivel = 'warning', extra: Record<string, unknown> = {}) {
  if (!ligado) return
  Sentry.captureMessage(msg, { level: nivel, extra })
}

/** Erro que a function engole de propósito (best-effort) e não pode sumir. */
export function reportar(erro: unknown, extra: Record<string, unknown> = {}) {
  if (!ligado) return
  Sentry.captureException(erro, { extra })
}

/** `Deno.serve` com Sentry em volta. Exceção é reportada e RELANÇADA, então a
 *  resposta continua sendo o 500 do runtime, igual a antes. `cron` marca as
 *  functions chamadas pelo pg_cron: lá um 401 é segredo divergente entre o
 *  banco e a function, não aluno com sessão vencida. */
export function servir(
  nome: string,
  handler: (req: Request) => Promise<Response>,
  { cron = false }: { cron?: boolean } = {},
) {
  Deno.serve(async (req) => {
    if (!ligado) return await handler(req)
    return await Sentry.withIsolationScope(async (escopo) => {
      escopo.setTag('edge_function', nome)
      escopo.setTag('method', req.method)
      try {
        return await Sentry.startSpan({ name: nome, op: 'function.edge' }, async () => {
          const res = await handler(req)
          if (res.status >= 500) {
            Sentry.captureMessage(`${nome}: HTTP ${res.status}`, 'error')
          } else if (cron && res.status === 401) {
            Sentry.captureMessage(`${nome}: x-cron-secret recusado`, 'warning')
          }
          return res
        })
      } catch (e) {
        Sentry.captureException(e)
        throw e
      } finally {
        // o isolate pode ser congelado logo depois da resposta: sem flush o
        // evento fica na fila de um processo que não volta
        await Sentry.flush(2000)
      }
    })
  })
}
