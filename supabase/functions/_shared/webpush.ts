// Envio de web push com a VAPID do projeto, compartilhado pelas functions que
// notificam (push-slot, push-teste). Existia só dentro do push-slot; com o aviso
// de teste, duplicar significaria duas cópias do setVapidDetails e duas regras
// diferentes pra inscrição morta.
import webpush from 'npm:web-push@3.6.7'

webpush.setVapidDetails(
  'mailto:ibsala.app@gmail.com',
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
)

export type Inscricao = { endpoint: string; p256dh: string; auth: string }

/** Teto por endpoint. Sem ele, um push service que aceita a conexão e não
 *  responde segura a function inteira até o runtime matá-la: com 1.000 alunos e
 *  a fila de envio, um endpoint pendurado atrasava todo mundo que veio depois
 *  dele. A opção `timeout` do web-push destrói o socket de verdade (3.6.7); o
 *  `Promise.race` é a rede de baixo, para o caso de a camada node do Deno não
 *  honrar o evento de timeout. */
const TETO_MS = 10_000

function comTeto<T>(p: Promise<T>, ms: number): Promise<T> {
  let id: ReturnType<typeof setTimeout> | undefined
  const estouro = new Promise<never>((_, falha) => {
    id = setTimeout(() => falha(new Error('timeout local')), ms)
  })
  return Promise.race([p, estouro]).finally(() => clearTimeout(id))
}

// 'enviado' | 'morta' (404/410: o push service não conhece mais o endpoint, quem
// chamou tem que apagar a linha) | 'falha' (o resto, que vale tentar de novo)
export async function enviar(s: Inscricao, payload: unknown) {
  try {
    await comTeto(
      webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { timeout: TETO_MS },
      ),
      TETO_MS + 5_000,
    )
    return 'enviado' as const
  } catch (e: any) {
    // `as const` na expressão inteira não compila (TS1355): o tipo vem de cada
    // ramo. Isto nunca foi conferido porque o projeto não tinha Deno instalado
    const morta = e?.statusCode === 404 || e?.statusCode === 410
    return morta ? ('morta' as const) : ('falha' as const)
  }
}
