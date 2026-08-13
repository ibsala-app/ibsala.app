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

// 'enviado' | 'morta' (404/410: o push service não conhece mais o endpoint, quem
// chamou tem que apagar a linha) | 'falha' (o resto, que vale tentar de novo)
export async function enviar(s: Inscricao, payload: unknown) {
  try {
    await webpush.sendNotification(
      { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      JSON.stringify(payload),
    )
    return 'enviado' as const
  } catch (e: any) {
    return (e?.statusCode === 404 || e?.statusCode === 410 ? 'morta' : 'falha') as const
  }
}
