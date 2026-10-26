// Regressões do Sentry com o mesmo SDK que o navegador usa e rede controlada.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const web = path.join(__dirname, '../web')
const app = fs.readFileSync(path.join(web, 'app.js'), 'utf8')
const trecho = (a, b) => app.slice(app.indexOf(a), app.indexOf(b, app.indexOf(a)))
function ambiente(fetch) {
  const eventos = []
  const elementos = new Map()
  const ctx = vm.createContext({
    URL, URLSearchParams, Headers, Request, Response, AbortController, AbortSignal,
    TextEncoder, TextDecoder, atob, btoa, crypto: globalThis.crypto,
    WebSocket: globalThis.WebSocket, console, fetch,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 30)), clearTimeout,
    setInterval, clearInterval,
    reportar: (...e) => eventos.push(e), rastro: () => {},
    $: (id) => {
      if (!elementos.has(id)) elementos.set(id, { hidden: true, replaceChildren() {}, classList: { remove() {}, add() {} } })
      return elementos.get(id)
    },
    agoraBRT: () => new Date('2026-10-12T12:00:00Z'), slotAtual: () => 'manha1',
    aplicarTrava() {}, pintarAgora() {}, pintarHoje() {},
    falhaNoMapa() { throw Error('mapa falhou') },
  })
  vm.runInContext(fs.readFileSync(path.join(web, 'vendor/supabase-2.112.3.min.js'), 'utf8'), ctx)
  vm.runInContext(`const window = {supabase}; const SUPABASE_URL = 'https://example.supabase.co';
    const SUPABASE_KEY = 'sb_publishable_teste';` + trecho('const sb =', '// ── Slots'), ctx)
  vm.runInContext(trecho('async function comTeto', '// Botão que faz rede'), ctx)
  vm.runInContext(`let mapaHoje = [], mapaCarregado = false, salas = [], posHoje = [], cfg = {}, totalAlunos = null, perfil = null;`
    + trecho('let seqAgora =', '// Polling que enxerga'), ctx)
  vm.runInContext(trecho('function cancelarBusca', 'for (const tela of Object.values(BUSCAS))'), ctx)
  return {ctx, eventos, run: (s) => vm.runInContext(s, ctx)}
}
const ok = (body) => new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}})
const estado = (marca) => ({marca, mapa: [{codigo: marca}], salas: [], pos: [], config: [], total: 1})

test('mapa público não usa o JWT da conta nem espera pelo refresh', async () => {
  let headers
  const a = ambiente(async (_, init) => { headers = new Headers(init.headers); return ok(estado('a')) })
  a.run(`sb.auth.getSession = async () => ({data: {session: {access_token: 'jwt-invalido'}}});
    sb.rpc = () => {throw Error('o mapa tentou usar a conta')}`)
  assert.equal((await a.run('estadoPublico(new AbortController().signal)')).marca, 'a')
  assert.equal(headers.get('authorization'), 'Bearer sb_publishable_teste')
})

test('busca cancelada aborta o fetch e não reporta timeout', async () => {
  let iniciou, abortou = false, chamadas = 0
  const inicio = new Promise((r) => { iniciou = r })
  const a = ambiente(async (_, init) => {
    chamadas++; iniciou()
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => {
      abortou = true; reject(new DOMException('cancelado', 'AbortError'))
    }, {once: true}))
  })
  const ctrl = new AbortController(); a.ctx.ctrl = ctrl
  const p = a.run(`chamar(sbPublico.from('disciplinas_historico').select('*'), 9000, undefined, ctrl.signal)`)
  await inicio; ctrl.abort()
  assert.equal((await p).error.tipo, 'cancelado')
  assert.equal(abortou, true); assert.equal(chamadas, 1); assert.equal(a.eventos.length, 0)
})

test('teto do mapa aborta a primeira tentativa antes de repetir', async () => {
  let chamadas = 0, abortou = false
  const a = ambiente(async (_, init) => {
    if (++chamadas > 1) return ok(estado('novo'))
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => {
      abortou = true; reject(new DOMException('timeout', 'AbortError'))
    }, {once: true}))
  })
  assert.equal(await a.run('carregarAgora()'), true)
  assert.equal(abortou, true); assert.equal(chamadas, 2)
  assert.equal(a.run('marcaEstado'), 'novo'); assert.equal(a.eventos.length, 0)
})

test('carga nova vence resposta antiga e só ela confirma a marca', async () => {
  let iniciou, responder
  const inicio = new Promise((r) => { iniciou = r })
  let n = 0
  const a = ambiente(async () => {
    if (++n === 1) { iniciou(); return new Promise((r) => { responder = r }) }
    return ok(estado('novo'))
  })
  const velha = a.run('carregarAgora()'); await inicio
  assert.equal(await a.run('carregarAgora()'), true)
  responder(ok(estado('velho'))); await velha
  assert.equal(a.run('marcaEstado'), 'novo'); assert.equal(a.run('mapaHoje[0].codigo'), 'novo')
})

test('limpar a busca invalida e cancela a consulta anterior', async () => {
  const a = ambiente(async () => ok([]))
  a.ctx.ghostLinhas = () => {}; a.ctx.pronto = Promise.resolve()
  a.ctx.tela = {seq: 0, ctrl: new AbortController(), lista: 'lista', falha: 'falha', vazio: 'vazio', semMapa: 'semMapa', dica: 'dica'}
  const anterior = a.ctx.tela.ctrl
  vm.runInContext(trecho('async function buscar(', '// A pós entra como INFORMAÇÃO'), a.ctx)
  await a.run("buscar('', tela)")
  assert.equal(anterior.signal.aborted, true); assert.equal(a.ctx.tela.seq, 1)
})

test('timer de pedido concluído não aborta depois do sucesso', async () => {
  const a = ambiente(async () => ok([])); let abortou = false
  a.ctx.abortar = () => {abortou = true}
  assert.equal(await a.run('comTeto(Promise.resolve(42), 10, abortar)'), 42)
  await new Promise((r) => setTimeout(r, 20)); assert.equal(abortou, false)
})

// Reproduz a sequência do IBSALA-1A: consulta pendurada, home, busca outra vez.
test('sair da busca cancela fetch e debounce; voltar inicia consulta nova', async () => {
  let iniciou, abortou = false
  const inicio = new Promise((r) => { iniciou = r })
  const a = ambiente(async (_, init) => {
    iniciou()
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => {
      abortou = true; reject(new DOMException('cancelado', 'AbortError'))
    }, {once: true}))
  })
  a.ctx.ctrl = new AbortController()
  const p = a.run("chamar(sbPublico.from('disciplinas_historico').select('*'), 9000, undefined, ctrl.signal)")
  await inicio
  let debounceRodou = false, retomou = 0
  a.ctx.BUSCAS = {buscar: {seq: 0, ctrl: a.ctx.ctrl,
    timer: setTimeout(() => {debounceRodou = true}, 10), input: 'busca-input'}}
  a.ctx.TELAS = ['home', 'buscar']; a.ctx.perfil = null
  a.ctx.document = {querySelectorAll: () => []}
  a.run("window.scrollTo = () => {}")
  a.ctx.history = {pushState() {}}
  a.ctx.sentry = () => {}
  a.ctx.buscar = () => {retomou++}
  a.run("$('tela-home').querySelector = $('tela-buscar').querySelector = () => null; $('busca-input').value = 'calculo'")
  vm.runInContext(trecho("let telaAtual = 'home'", "document.querySelectorAll('[data-vai]')"), a.ctx)
  a.run("telaAtual = 'buscar'; mostrar('home')")
  assert.equal((await p).error.tipo, 'cancelado')
  assert.equal(abortou, true)
  assert.equal(a.ctx.BUSCAS.buscar.seq, 1)
  assert.equal(a.eventos.length, 0)
  a.run("mostrar('buscar')")
  assert.equal(retomou, 1)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(debounceRodou, false)
})

test('timeout persistente de busca ativa continua reportado', async () => {
  let chamadas = 0
  const a = ambiente(async (_, init) => {
    chamadas++
    return new Promise((_, reject) => init.signal.addEventListener('abort', () =>
      reject(new DOMException('timeout', 'AbortError')), {once: true}))
  })
  const r = await a.run("chamar(sbPublico.from('disciplinas_historico').select('*'), 9000)")
  assert.equal(r.error.tipo, 'rede')
  assert.equal(chamadas, 2)
  assert.equal(a.eventos.length, 1)
})

test('mapa sem rede ou logo após trocar de rede fica no rastro, rede estável vira warning', async () => {
  const caiu = async () => { throw new TypeError('Load failed') }
  const falhar = async (a) => {
    await assert.rejects(a.run('carregarAgora()'), /mapa falhou/)
    return a.eventos
  }
  const offline = ambiente(caiu); offline.ctx.navigator = {onLine: false}
  assert.equal((await falhar(offline)).length, 0)
  const trocou = ambiente(caiu); trocou.run('redeMudouEm = Date.now()')
  assert.equal((await falhar(trocou)).length, 0)
  const estavel = ambiente(caiu)
  const [ev] = await falhar(estavel)
  assert.equal(ev[1].nivel, 'warning')
})
