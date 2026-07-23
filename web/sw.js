// ibsala v5 — service worker: casca offline + web push
const CACHE = 'ibsala-v5-2'
const SHELL = ['/', '/style.css', '/app.js', '/config.js', '/manifest.json',
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
    e.respondWith(fetch(e.request).catch(() => caches.match('/')))
    return
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit ?? fetch(e.request).then((resp) => {
      if (resp.ok) {
        const clone = resp.clone()
        caches.open(CACHE).then((c) => c.put(e.request, clone))
      }
      return resp
    })))
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
