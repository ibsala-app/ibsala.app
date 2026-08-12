// ibsala v5 — service worker: casca offline + web push
const CACHE = 'ibsala-v5-16'
const SHELL = ['/', '/style.css', '/app.js', '/config.js', '/manifest.json',
  '/privacidade.html', '/termos.html',
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
  e.respondWith(
    fetch(e.request).then((resp) => {
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
  e.waitUntil(self.registration.showNotification(d.title || 'IBSALA', {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: d.tag || 'ibsala',
  }))
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  e.waitUntil(clients.matchAll({ type: 'window' }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus()
    return clients.openWindow('/')
  }))
})
