import { assertEquals } from 'jsr:@std/assert@1'
import { buscar, ESPERAS_MS } from './retentar.ts'

/** `fetch` de mentira que devolve os status na ordem e conta as chamadas. */
function falso(status: number[]) {
  const chamadas: RequestInit[] = []
  const f = ((_url: string, init: RequestInit = {}) => {
    chamadas.push(init)
    const s = status[Math.min(chamadas.length - 1, status.length - 1)]
    return Promise.resolve(new Response(s === 200 ? '[]' : 'nope', { status: s }))
  }) as typeof fetch
  return { f, chamadas }
}

function relogio() {
  const pausas: number[] = []
  return { pausas, dormir: (ms: number) => { pausas.push(ms); return Promise.resolve() } }
}

Deno.test('200 de primeira não repete nem espera', async () => {
  const { f, chamadas } = falso([200])
  const { pausas, dormir } = relogio()
  const r = await buscar('http://x', {}, { fetch: f, dormir })
  assertEquals(r.status, 200)
  assertEquals(chamadas.length, 1)
  assertEquals(pausas, [])
})

Deno.test('401 passageiro vira 200 na tentativa seguinte', async () => {
  const { f, chamadas } = falso([401, 200])
  const { pausas, dormir } = relogio()
  const r = await buscar('http://x', {}, { fetch: f, dormir })
  assertEquals(r.status, 200)
  assertEquals(await r.text(), '[]')
  assertEquals(chamadas.length, 2)
  assertEquals(pausas, [ESPERAS_MS[0]])
})

Deno.test('401 que não passa devolve o 401 depois de esgotar as pausas', async () => {
  const { f, chamadas } = falso([401])
  const { pausas, dormir } = relogio()
  const r = await buscar('http://x', {}, { fetch: f, dormir })
  assertEquals(r.status, 401)
  assertEquals(chamadas.length, ESPERAS_MS.length + 1)
  assertEquals(pausas, ESPERAS_MS)
})

Deno.test('escritas não repetem 5xx ou 4xx que não são 401', async () => {
  for (const s of [400, 403, 404, 409, 500, 503]) {
    const { f, chamadas } = falso([s, 200])
    const { pausas, dormir } = relogio()
    const r = await buscar('http://x', { method: 'POST', body: '{}' }, { fetch: f, dormir })
    assertEquals(r.status, s)
    assertEquals(chamadas.length, 1, `status ${s}`)
    assertEquals(pausas, [])
  }
})

Deno.test('a repetição leva o mesmo método, cabeçalho e corpo', async () => {
  const { f, chamadas } = falso([401, 200])
  const { dormir } = relogio()
  const init = { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: '[{"a":1}]' }
  await buscar('http://x', init, { fetch: f, dormir })
  assertEquals(chamadas, [init, init])
})

Deno.test('leitura repete 555 e outros 5xx, mas não oculta falha persistente', async () => {
  for (const status of [500, 502, 503, 504, 555]) {
    const { f, chamadas } = falso([status, 200])
    const { dormir } = relogio()
    assertEquals((await buscar('http://x', {}, { fetch: f, dormir })).status, 200)
    assertEquals(chamadas.length, 2)
  }
  const { f, chamadas } = falso([555])
  const { dormir } = relogio()
  assertEquals((await buscar('http://x', {}, { fetch: f, dormir })).status, 555)
  assertEquals(chamadas.length, ESPERAS_MS.length + 1)
})

Deno.test('RPC de contagem repete 555; claim POST não repete', async () => {
  for (const leitura of [true, false]) {
    const { f, chamadas } = falso([555, 200])
    const { dormir } = relogio()
    const r = await buscar('http://x', { method: 'POST', body: '{}' }, { fetch: f, dormir, leitura })
    assertEquals(r.status, leitura ? 200 : 555)
    assertEquals(chamadas.length, leitura ? 2 : 1)
  }
})

Deno.test('erro de rede só repete leitura e respeita cancelamento', async () => {
  for (const method of ['GET', 'POST']) {
    let chamadas = 0
    const f = (() => {
      if (++chamadas === 1) return Promise.reject(new TypeError('fetch failed'))
      return Promise.resolve(new Response('ok'))
    }) as typeof fetch
    const { dormir } = relogio()
    try {
      const r = await buscar('http://x', { method }, { fetch: f, dormir })
      assertEquals(method, 'GET')
      assertEquals(await r.text(), 'ok')
    } catch (e) {
      assertEquals(method, 'POST')
      assertEquals((e as Error).message, 'fetch failed')
    }
    assertEquals(chamadas, method === 'GET' ? 2 : 1)
  }
  const ctrl = new AbortController()
  let chamadas = 0
  const f = (() => { chamadas++; ctrl.abort(); return Promise.reject(new Error('cancelado')) }) as typeof fetch
  const { dormir, pausas } = relogio()
  try { await buscar('http://x', { signal: ctrl.signal }, { fetch: f, dormir }) } catch { /* esperado */ }
  assertEquals(chamadas, 1)
  assertEquals(pausas, [])
})
