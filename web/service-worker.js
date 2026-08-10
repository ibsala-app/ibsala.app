// Lápide do service worker do v1.
//
// O v1 registrava '/service-worker.js' e o v5 registra '/sw.js'. Nomes
// diferentes significam registros diferentes: quem instalou a PWA velha
// continua com o SW do v1 ATIVO e no controle de ibsala.com.br depois do
// cutover. Esse SW intercepta tudo e derruba as requisições cross-origin
// (jsdelivr, fonts, sentry), então o v5 quebra no boot: `window.supabase`
// fica undefined e o app.js morre na linha 4 antes de conseguir registrar o
// SW novo. Deadlock: o SW velho impede exatamente o código que o substituiria.
//
// O Pages não resolvia isso sozinho porque '/service-worker.js' caía no
// fallback de SPA e voltava index.html com `content-type: text/html`, MIME
// que reprova a atualização do worker e mantém o registro velho vivo.
//
// Este arquivo existe pra ser esse update: instala, apaga os caches do v1,
// se desregistra e recarrega as abas abertas. Na recarga não há mais SW
// nenhum, o app.js roda inteiro e registra o '/sw.js' do v5.
//
// Só some quando ninguém mais tiver a PWA do v1 instalada. Custo de manter:
// um arquivo de 20 linhas.

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const nomes = await caches.keys()
    await Promise.all(nomes.map((n) => caches.delete(n)))
    await self.registration.unregister()
    const abas = await self.clients.matchAll({ type: 'window' })
    for (const aba of abas) aba.navigate(aba.url)
  })())
})
