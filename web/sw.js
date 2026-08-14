// ibsala v5 — service worker: casca offline + web push
const CACHE = 'ibsala-v5-31'
// O `?v=` do index.html entra no precache: `caches.match` compara a URL inteira,
// query junto, então guardar `/app.js` cru deixaria o pedido real (`/app.js?v=20`)
// sem reserva offline. Um número só, tirado do próprio CACHE, pra não existir
// segunda fonte de verdade que possa divergir da primeira.
const V = CACHE.split('-').pop()
const SHELL = ['/', `/style.css?v=${V}`, `/app.js?v=${V}`, `/config.js?v=${V}`,
  '/manifest.json', '/privacidade.html', '/termos.html',
  '/vendor/supabase.min.js',
  '/fonts/inter-latin.woff2', '/fonts/inter-latin-ext.woff2',
  '/icons/icon-192.png', '/icons/icon-512.png', '/favicon.svg']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()))
})

// O Cloudflare Pages NÃO deixa o `_headers` sobrescrever Cache-Control em js e
// css da RAIZ: medido três vezes em produção (caminho exato, padrão de extensão
// e bloco `/*`), sempre volta `max-age=14400`. Dentro de pasta ele obedece, por
// isso fonte, vendor e ícones ficam imutáveis de um ano. Como `fetch` do worker
// passa pelo cache HTTP do navegador, sem isto um deploy continuaria levando até
// 4 HORAS pra chegar em quem já tinha aberto o app, que é a mesma classe de
// problema que gerou três "não consertou" em 12/08. `cache: 'reload'` pula o
// cache HTTP só nestes três arquivos, que somam ~57KB; o bundle de 207KB e as
// fontes continuam vindo do cache do navegador.
const SEMPRE_FRESCO = new Set(['/app.js', '/style.css', '/config.js'])

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return
  // navegação e API: rede primeiro; estático: cache primeiro
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request)
      .catch(async () => (await caches.match(e.request)) || (await caches.match('/'))))
    return
  }
  // REDE PRIMEIRO, cache de reserva. Era cache-primeiro, e isso custou caro:
  // depois de cada deploy o aluno ficava com o CSS e o JS velhos até a página
  // recarregar DUAS vezes, então conserto no ar aparecia como "não consertou"
  // (aconteceu três vezes em 12/08: barra de status, alinhamento das colunas e
  // botão colado). O arquivo versionado (fonte, bundle) tem Cache-Control
  // immutable, então o cache HTTP do navegador segura o tráfego de qualquer jeito.
  const pedido = SEMPRE_FRESCO.has(url.pathname)
    ? new Request(e.request, { cache: 'reload' })
    : e.request

  e.respondWith(
    fetch(pedido).then((resp) => {
      if (resp.ok) {
        const clone = resp.clone()
        caches.open(CACHE).then((c) => c.put(e.request, clone))
      }
      return resp
    }).catch(() => caches.match(e.request)))
})

self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data.json() } catch { d = { body: e.data && e.data.text() } }
  const tag = d.tag || 'ibsala'
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'IBSALA', {
      body: d.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag,
    })
    // o aviso de teste tem que PROVAR entrega: sem este recado, a tela de
    // Ajustes só saberia que o servidor aceitou o envio, e "aceito" não é
    // "chegou". `includeUncontrolled` porque a aba pode não estar sob o worker
    // novo ainda (primeira carga depois de um deploy).
    if (tag !== 'ibsala-teste') return
    const abas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of abas) c.postMessage({ tipo: 'push-teste-recebido', em: Date.now() })
  })())
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  e.waitUntil(clients.matchAll({ type: 'window' }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus()
    return clients.openWindow('/')
  }))
})
