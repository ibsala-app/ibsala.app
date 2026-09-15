import { assertEquals } from 'jsr:@std/assert@1'
import { endpointConhecido } from './push-hosts.ts'

Deno.test('aceita os push services dos navegadores', () => {
  for (const e of [
    'https://fcm.googleapis.com/fcm/send/abc:APA91b',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://web.push.apple.com/QGx1c2VyLWlk',
    'https://wns2-bl2p.notify.windows.com/w/?token=BQYAAA',
  ]) assertEquals(endpointConhecido(e), true, e)
})

Deno.test('recusa rede interna, http e host parecido', () => {
  for (const e of [
    'https://127.0.0.1:5432/',
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com.atacante.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'https://atacante.com/https://fcm.googleapis.com/',
    'https://web.push.apple.com@atacante.com/',
    'https://fcm.googleapis.com',
    '',
  ]) assertEquals(endpointConhecido(e), false, e)
})

Deno.test('recusa endpoint gigante', () => {
  assertEquals(endpointConhecido('https://fcm.googleapis.com/' + 'a'.repeat(1100)), false)
})
