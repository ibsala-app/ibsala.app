// Configuração do Sentry. Vem ANTES do loader no index.html: o loader chama
// `window.sentryOnLoad` assim que o SDK chega, e é ali que o init mora. Arquivo
// e não <script> inline porque a CSP não tem 'unsafe-inline'.
//
// O que a chave do loader liga (painel do Sentry, ibsala-pp/ibsala, Loader
// Script): tracing, replay e logs, SDK 10.x. O bundle passa de 31 KB pra 89 KB
// gzip, em `defer` e de CDN, fora do caminho do boot.
//
// Até 02/10 o loader estava em modo lazy, que só baixa o SDK no primeiro erro:
// clique, fetch e troca de tela anteriores ao erro nunca viravam breadcrumb, e
// o evento chegava sem o caminho que levou até ele. `data-lazy="no"` no index.
;(function () {
  var src = (document.currentScript && document.currentScript.src) || ''
  var versao = (/[?&]v=(\d+)/.exec(src) || [])[1] || 'dev'
  var host = location.hostname
  var ambiente = host === 'ibsala.com.br' || host === 'www.ibsala.com.br'
    ? 'producao'
    : /\.pages\.dev$/.test(host) ? 'preview' : 'local'

  window.sentryOnLoad = function () {
    var S = window.Sentry
    var integracoes = []
    // replay só de sessão que teve erro (a cota grátis é de 50 por mês, e 10%
    // das sessões a queimaria em poucos dias). Texto e mídia mascarados: o
    // replay mostra o caminho, não o que o aluno tem na tela. Sem compressão
    // porque o worker de compressão nasce de `blob:`, que a CSP não libera.
    if (S.replayIntegration) {
      integracoes.push(S.replayIntegration({
        maskAllText: true, maskAllInputs: true, blockAllMedia: true, useCompression: false,
      }))
    }
    if (S.browserTracingIntegration) {
      integracoes.push(S.browserTracingIntegration({ enableInp: true }))
    }
    // console.warn e console.error viram log no Sentry, com o contexto da sessão
    if (S.consoleLoggingIntegration) {
      integracoes.push(S.consoleLoggingIntegration({ levels: ['warn', 'error'] }))
    }

    S.init({
      release: 'ibsala@v' + versao,
      environment: ambiente,
      // o smoke do CI roda em 127.0.0.1 com o Supabase bloqueado de propósito, e
      // cada PR virava evento de "mapa não carregou" (IBSALA-S, 02/10)
      enabled: ambiente !== 'local',
      sendDefaultPii: false,
      tracesSampleRate: 1.0,
      // só o próprio site: header de trace no supabase.co vira preflight de CORS
      tracePropagationTargets: [/^\/(?!\/)/],
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 1.0,
      enableLogs: true,
      maxBreadcrumbs: 100,
      integrations: integracoes,
      // estilo e fetch injetados por extensão (IBSALA-Q, Opera GX) não são do app
      denyUrls: [/^chrome-extension:\/\//i, /^moz-extension:\/\//i, /^safari-(web-)?extension:\/\//i],
      initialScope: {
        tags: {
          pwa: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
            ? 'instalada' : 'navegador',
          sw: navigator.serviceWorker && navigator.serviceWorker.controller ? 'controlando' : 'nenhum',
          rede: (navigator.connection && navigator.connection.effectiveType) || 'desconhecida',
        },
      },
    })
  }
})()
