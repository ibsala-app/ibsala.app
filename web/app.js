// `?v=` no import também: a query do `<script>` não é herdada pelo import
// estático, e config.js carrega a chave VAPID. O número acompanha o CACHE do
// sw.js e é verificado por scripts/versao.py.
import { SUPABASE_URL, SUPABASE_KEY, VAPID_PUBLIC_KEY } from './config.js?v=23'

// ANTES de qualquer coisa que possa lançar: se o bundle UMD não chegar, a linha
// de baixo mata o módulo inteiro, e era ela que impedia o registro do SW novo
// no cutover (o SW do v1 derrubava o jsdelivr e sobrevivia por isso)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js')

// PWA instalada no iPhone não faz navegação nova quando o iOS traz o app de
// volta do segundo plano: ele restaura a página que já estava na memória. Sem
// navegação, nada é buscado, o worker novo não assume, e versão nova só aparecia
// depois de matar o app na gaveta. Aqui o app procura atualização ao voltar pro
// primeiro plano e recarrega UMA vez quando o worker novo toma o controle.
const tinhaControlador = !!navigator.serviceWorker?.controller
let recarregandoPraAtualizar = false
// digitando não se recarrega: `procurarAtualizacao` roda a cada volta ao
// primeiro plano, e um deploy no meio do cadastro apagava o username que o
// aluno estava escrevendo
const estaEscrevendo = () => {
  const el = document.activeElement
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !!el.value
}
navigator.serviceWorker?.addEventListener('controllerchange', () => {
  // primeira instalação também dispara controllerchange, e aí recarregar é ruído
  if (!tinhaControlador || recarregandoPraAtualizar) return
  if (estaEscrevendo()) {
    // recarrega quando ele sair do campo, não por cima do que ele digitou
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && !recarregandoPraAtualizar) {
        recarregandoPraAtualizar = true
        location.reload()
      }
    }, { once: true })
    return
  }
  recarregandoPraAtualizar = true
  location.reload()
})
async function procurarAtualizacao() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    await reg?.update()
  } catch { /* offline, ou sem worker: tenta na próxima */ }
}

// supabase-js chega via bundle UMD self-hospedado (script defer no index).
// O `?.` é cinto de segurança: quando isso vinha do jsdelivr e a rede bloqueava o
// CDN, esta linha lançava e matava o módulo inteiro, então NENHUM botão da página
// respondia (os listeners de clique nem chegavam a ser registrados). Agora, se o
// bundle faltar, a navegação continua funcionando e o app diz o que aconteceu.
const sb = window.supabase?.createClient(SUPABASE_URL, SUPABASE_KEY) ?? null

// ── Slots (portado do v1) ────────────────────────────────────────────────────
// Janela de vigência do slot, não o horário da aula: serve pra dizer "em que
// slot estamos agora" e pra casar aula com slot por sobreposição.
const SLOTS = {
  manha1: { label: '1º Manhã', ini: 6 * 60,       fim: 9 * 60 + 29 },
  manha2: { label: '2º Manhã', ini: 9 * 60 + 30,  fim: 12 * 60 + 59 },
  tarde1: { label: '1º Tarde', ini: 13 * 60,      fim: 15 * 60 + 29 },
  tarde2: { label: '2º Tarde', ini: 15 * 60 + 30, fim: 17 * 60 + 59 },
  noite1: { label: '1º Noite', ini: 18 * 60,      fim: 18 * 60 + 59 },
  noite2: { label: '2º Noite', ini: 19 * 60,      fim: 23 * 60 + 59 },
}
const DIAS = ['', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB']
const DIAS_LONGO = ['DOMINGO', 'SEGUNDA', 'TERÇA', 'QUARTA', 'QUINTA', 'SEXTA', 'SÁBADO']
const TELAS = ['home', 'agora', 'buscar', 'conta', 'ajustes', 'admin']
// muda junto com o texto de termos.html; é o que fica gravado em alunos
const TERMOS_VERSAO = '1-2026-08-12'

function agoraBRT() {
  // o parse de "8/12/2026, 3:04:05 PM" depende do motor; se falhar, o relógio
  // local é melhor que Invalid Date virando NaN no cabeçalho inteiro
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
  return isNaN(d) ? new Date() : d
}
function hojeISO() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' })
}
function minutosAgora() {
  const d = agoraBRT()
  return d.getHours() * 60 + d.getMinutes()
}
function slotAtual() {
  const m = minutosAgora()
  for (const [k, s] of Object.entries(SLOTS)) if (m >= s.ini && m <= s.fim) return k
  return null
}

// A fonte escreve o intervalo como "18:40/22:30", e às vezes com typo no meio
// ("11/:00/18:00"). Varrer todos os HH:MM sobrevive aos dois.
function faixaHoraria(h) {
  const hs = [...String(h ?? '').matchAll(/(\d{1,2}):(\d{2})/g)].map((m) => +m[1] * 60 + +m[2])
  if (!hs.length) return null
  return [hs[0], hs.length > 1 ? hs[hs.length - 1] : hs[0]]
}
function intervaloContem(horario, min) {
  const f = faixaHoraria(horario)
  return !!f && min >= f[0] && min <= f[1]
}
// Ocupação é sobreposição, não "o slot do primeiro horário": aula de 18:40/22:30
// ocupa a sala no 1º E no 2º noite, e tratar só o primeiro deixava 19 salas
// aparecendo como livres com aula dentro depois das 19h.
function intervaloCobreSlot(horario, s) {
  const f = faixaHoraria(horario)
  return !!f && f[0] <= s.fim && f[1] >= s.ini
}
// Lista de aula do dia é AGENDA: ordena por horário de início, e só desempata
// por disciplina. Sem isto a ordem era a que o banco devolveu, então a aula das
// 15:50 aparecia antes da de 09:50 na mesma busca.
function porHorario(a, b) {
  const ia = faixaHoraria(a.horario)?.[0] ?? Infinity
  const ib = faixaHoraria(b.horario)?.[0] ?? Infinity
  return ia - ib ||
    String(a.disciplina ?? '').localeCompare(String(b.disciplina ?? ''), 'pt-BR')
}

function proximoSlot(min) {
  for (const [k, s] of Object.entries(SLOTS)) if (s.ini > min) return { k, ...s }
  return null
}

// ── Tema ─────────────────────────────────────────────────────────────────────
// Só existia o do sistema. Quem usa o celular no claro e prefere o app escuro
// (ou o contrário) não tinha o que fazer. Fica no aparelho, não na conta.
const TEMA_CHAVE = 'ibsala:tema'
function aplicarTema(qual) {
  const escolha = ['claro', 'escuro'].includes(qual) ? qual : 'sistema'
  if (escolha === 'sistema') document.documentElement.removeAttribute('data-tema')
  else document.documentElement.setAttribute('data-tema', escolha)
  try {
    if (escolha === 'sistema') localStorage.removeItem(TEMA_CHAVE)
    else localStorage.setItem(TEMA_CHAVE, escolha)
  } catch { /* navegação privada: vale só nesta aba */ }
  return escolha
}
function temaGuardado() {
  try { return localStorage.getItem(TEMA_CHAVE) ?? 'sistema' } catch { return 'sistema' }
}
// antes do primeiro quadro, senão a tela pisca no tema errado
aplicarTema(temaGuardado())

// ── UI helpers ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id)

// Um id que sumiu (rename entre deploys, HTML novo com JS velho) matava o
// módulo inteiro na primeira linha: eram 17 addEventListener no nível do
// arquivo, nenhum com guarda. IBSALA-F, 12/08: `$('btn-push')` veio null depois
// que o #22 renomeou o botão pra `chk-push`, e com isso login, busca, exportação
// e exclusão de conta pararam de responder junto. Agora o id ausente vira UM
// evento no Sentry e um botão morto, não um app morto.
const faltando = []
const on = (id, evento, fn, opcoes) => {
  const el = $(id)
  if (!el) { faltando.push(id); return }
  el.addEventListener(evento, fn, opcoes)
}

let toastTimer
function toast(msg) {
  const t = $('toast')
  t.textContent = msg
  t.classList.add('on')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('on'), 3200)
}
function li(html) {
  const el = document.createElement('li')
  el.innerHTML = html
  return el
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// componentes fantasma: o que aparece enquanto o dado não chegou, no lugar de
// "–" e lista vazia (que se confundem com "não tem nada hoje")
function ghostLinhas(el, n = 3) {
  el.setAttribute('aria-busy', 'true')
  el.replaceChildren(...Array.from({ length: n }, () => {
    const l = document.createElement('li')
    l.className = 'ghost-li'
    l.setAttribute('aria-hidden', 'true')
    l.innerHTML = '<span class="ghost g-disc"></span><span class="ghost g-sala"></span>' +
      '<span class="ghost g-meta"></span>'
    return l
  }))
}
function ghostChips(el, n = 12) {
  el.setAttribute('aria-busy', 'true')
  el.replaceChildren(...Array.from({ length: n }, () => {
    const c = document.createElement('span')
    c.className = 'ghost g-chip'
    c.setAttribute('aria-hidden', 'true')
    return c
  }))
}

// ── Navegação (com history, pra o gesto de voltar não fechar a PWA) ──────────
let telaAtual = 'home'

// lido no carregamento, antes de qualquer mostrar() mexer no hash: é o que
// separa "abriu no /" de "abriu no /#agora" (atalho do manifest ou link colado)
const HASH_NO_BOOT = location.hash.replace('#', '')
let roteouLogado = false

// telas que só existem pra quem tem conta: digitar #ajustes deslogado abria uma
// tela de configurações vazia, sem dizer por quê
const TELAS_LOGADO = ['ajustes', 'admin']

function mostrar(tela, { push = true } = {}) {
  if (!TELAS.includes(tela)) tela = 'home'
  if (TELAS_LOGADO.includes(tela) && !perfil) tela = 'conta'
  if (tela === 'admin' && perfil?.role !== 'admin') tela = 'conta'
  document.querySelectorAll('.tela').forEach((x) => x.classList.remove('ativa'))
  const secao = $(`tela-${tela}`)
  secao.classList.add('ativa')
  telaAtual = tela
  window.scrollTo(0, 0)
  if (push) history.pushState({ tela }, '', tela === 'home' ? '#' : `#${tela}`)
  // foco vai pro cabeçalho da tela nova, senão ele fica no botão que acabou de
  // virar display:none e o teclado perde o lugar
  secao.querySelector('[data-cabeca]')?.focus({ preventScroll: true })
}

document.querySelectorAll('[data-vai]').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.intencao) aplicarIntencao(b.dataset.intencao)
    // o botão Voltar empilhava entrada nova: o histórico virava [#, #agora, #]
    // e o gesto de voltar do iPhone levava DE VOLTA pra tela de onde ele saiu
    if (b.classList.contains('voltar') && history.length > 1 && telaAtual !== 'home') {
      history.back()
      return
    }
    mostrar(b.dataset.vai)
  })
})

// sem o fallback pro hash, o atalho do manifest ("/#agora") com o app JÁ aberto
// dispara popstate com state nulo e cai na home em vez da tela pedida
window.addEventListener('popstate', (e) =>
  mostrar(e.state?.tela ?? location.hash.replace('#', '') ?? 'home', { push: false }))

// ── Estado compartilhado ─────────────────────────────────────────────────────
let mapaHoje = []
let minhas = []
let salas = []
let cfg = {}
let totalAlunos = null
let pronto = null
let mapaCarregado = false

// ── Rede ─────────────────────────────────────────────────────────────────────
// Rede de celular pendura requisição sem avisar, e sem teto de tempo a tela
// ficava em fantasma pra sempre: foi assim que, em aula do Osmar às 10:59, a
// busca respondeu "sem aula hoje" pra uma aula que estava acontecendo. O teto
// existia só no boot; as outras quinze chamadas do arquivo não tinham nenhum.
const comTeto = (p, ms = 9000) => Promise.race([
  p,
  new Promise((_, falha) => setTimeout(() => falha(new Error('tempo esgotado')), ms)),
])

// Erro do servidor vira frase que o aluno entende. Sem isto o app chamava tudo
// de "você já tem essa matéria nesse dia", inclusive sessão expirada.
function erroLegivel(e) {
  const c = e?.code ?? ''
  if (c === '23505') return { tipo: 'duplicado', msg: 'Isso já está na sua lista.' }
  if (c === 'PGRST301' || e?.status === 401 || e?.status === 403) {
    return { tipo: 'sessao', msg: 'Sua sessão expirou. Entra de novo.' }
  }
  if (c === '42501') return { tipo: 'permissao', msg: 'Sua conta não tem permissão pra isso.' }
  if (c === '23514' || c === '23502') return { tipo: 'invalido', msg: 'Dado inválido.' }
  return { tipo: 'servidor', msg: 'Sem resposta do servidor. Tenta de novo.' }
}

// Toda ida ao servidor passa por aqui: teto de tempo, erro classificado, e
// nenhuma promessa solta morrendo em silêncio no console.
async function chamar(q, ms = 9000) {
  if (!sb) {
    return { data: null, error: { tipo: 'offline', msg: 'O app não carregou por completo.' } }
  }
  let r
  try {
    r = await comTeto(Promise.resolve(q), ms)
  } catch {
    return { data: null, error: { tipo: 'rede', msg: 'Sem resposta do servidor. Tenta de novo.' } }
  }
  if (r?.error) return { data: null, error: erroLegivel(r.error) }
  return { data: r?.data ?? null, error: null }
}

// Botão que faz rede fica travado enquanto espera. Nenhum ficava: dois toques
// viravam duas matérias, duas reclamações, dois logins do Google.
async function ocupado(btn, tarefa) {
  if (!btn || btn.disabled) return
  btn.disabled = true
  btn.setAttribute('aria-busy', 'true')
  try {
    return await tarefa()
  } finally {
    btn.disabled = false
    btn.removeAttribute('aria-busy')
  }
}

// ── Faculdade agora ──────────────────────────────────────────────────────────
// Duas cargas simultâneas escreviam o mesmo estado sem ordem: o aluno tocava
// "Tentar de novo", a tela pintava certo, e 9s depois a chamada velha estourava
// o teto e chamava falhaNoMapa(), apagando a tela boa.
let seqAgora = 0

async function carregarAgora({ ghost = false } = {}) {
  if (!sb) return              // sem bundle não há o que buscar; o aviso já está na tela
  if (ghost) {
    $('livres-num').classList.add('ghost-num')
    ghostChips($('livres-grade'))
    ghostLinhas($('board-agora'))
  }
  const meu = ++seqAgora
  let mapa, inv, conf, quantos
  try {
    [mapa, inv, conf, quantos] = await comTeto(Promise.all([
      sb.from('mapa_dia').select('turma,codigo,disciplina,horario,professor,sala,sala_canon')
        .eq('data', hojeISO()),
      sb.from('salas').select('sala,predio').eq('ativa', true).order('sala'),
      sb.from('config').select('key,value'),
      sb.rpc('total_alunos'),
    ]))
  } catch {
    if (meu === seqAgora) falhaNoMapa()
    return
  }
  if (meu !== seqAgora) return          // resposta velha não pinta por cima da nova
  if (mapa.error || inv.error) { falhaNoMapa(); return }

  // Mapa vazio em dia útil dentro de horário de aula NÃO é "tudo livre": é o
  // mapa que ainda não chegou. A retenção apaga às 00:30 e a primeira captura
  // do dia é às 05h, e em 11/08 o app passou a madrugada inteira anunciando
  // salas livres demais e nenhuma aula.
  const diaUtil = agoraBRT().getDay() >= 1 && agoraBRT().getDay() <= 5
  if (!mapa.data.length && diaUtil && slotAtual()) { falhaNoMapa({ vazio: true }); return }

  $('agora-falha').hidden = true
  $('busca-sem-mapa').hidden = true
  mapaCarregado = true
  mapaHoje = mapa.data
  salas = inv.data
  if (!conf.error) cfg = Object.fromEntries((conf.data ?? []).map((r) => [r.key, r.value]))
  if (!quantos.error && typeof quantos.data === 'number') totalAlunos = quantos.data
  aplicarTrava()
  pintarAgora()
  // "Hoje" do aluno é montado cruzando as matérias com este mapa. Quando o
  // login resolvia primeiro (rota mais curta), a tela dizia "sem sala no mapa
  // de hoje" em TODAS as matérias e nunca mais se corrigia sozinha.
  if (perfil) pintarHoje()
}

// Data, turno e contagem pro próximo slot saem do RELÓGIO, não do servidor.
// Ficavam em "—" quando a rede falhava, e o cabeçalho parecia morto sem motivo.
function pintarRelogio() {
  const slot = slotAtual()
  const d = agoraBRT()
  const min = minutosAgora()

  $('pill-data').textContent =
    `${DIAS_LONGO[d.getDay()]} · ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
  $('pill-slot').textContent = slot ? SLOTS[slot].label : 'Fora de horário'

  // conta viva pro próximo slot: a tela se move sem ninguém tocar nela
  const prox = proximoSlot(min)
  const falta = prox ? prox.ini - min : null
  $('pill-troca').hidden = !(falta != null && falta <= 90)
  if (falta != null && falta <= 90) {
    $('pill-troca').textContent = falta <= 1 ? 'troca agora' : `troca em ${falta} min`
  }
}

function pintarAgora() {
  pintarRelogio()
  const slot = slotAtual()
  const min = minutosAgora()

  const ocupadas = new Set(
    slot
      ? mapaHoje.filter((r) => r.sala_canon && intervaloCobreSlot(r.horario, SLOTS[slot]))
        .map((r) => r.sala_canon)
      : [])
  const livres = slot ? salas.filter((s) => !ocupadas.has(s.sala)) : []

  $('livres-num').classList.remove('ghost-num')
  $('livres-num').textContent = slot ? livres.length : '–'
  $('livres-rotulo').textContent = slot
    ? `salas livres no ${SLOTS[slot].label.toLowerCase()}`
    : 'fora do horário de aulas'
  $('pill-livres').textContent = slot ? `${livres.length} livres` : `${salas.length} salas`

  // chips agrupados por prédio, e todos: cortar em 40 sem avisar escondia sala
  const grade = $('livres-grade')
  $('livres-vazio').hidden = !slot || livres.length > 0
  const predios = [...new Set(livres.map((s) => s.predio))].sort()
  grade.replaceChildren(...predios.flatMap((p) => {
    const rot = document.createElement('span')
    rot.className = 'grupo-rotulo'
    rot.textContent = p
    const chips = livres.filter((s) => s.predio === p).map((s) => {
      const c = document.createElement('span')
      c.className = 'sala-chip'
      c.textContent = s.sala
      return c
    })
    return [rot, ...chips]
  }))

  grade.removeAttribute('aria-busy')
  $('board-agora').removeAttribute('aria-busy')

  const rolando = []
  const vistos = new Set()
  for (const r of mapaHoje) {
    if (!intervaloContem(r.horario, min)) continue
    const k = [r.horario, r.sala, r.disciplina, r.turma, r.professor].join('|')
    if (vistos.has(k)) continue
    vistos.add(k)
    rolando.push(r)
  }
  rolando.sort(porHorario)
  $('board-agora').replaceChildren(...rolando.map((r) => li(`
    <span class="disc">${esc(r.disciplina || 'Reserva')}</span>
    <span class="sala">${esc(chipSala(r))}</span>
    <span class="meta">${esc(r.turma)} · ${esc(r.professor)} · ${esc(r.horario)}</span>`)))
  $('agora-vazio').hidden = rolando.length > 0

  // quantos já usam: prova social pra quem chega pelo QR code sem conta
  $('pill-alunos').hidden = !totalAlunos
  if (totalAlunos) {
    $('pill-alunos').textContent = `${totalAlunos} ${totalAlunos === 1 ? 'aluno' : 'alunos'}`
  }

  // frescor à vista: número sem hora não diz se é de agora ou das 3 da manhã
  const cap = cfg.ultima_captura
  const em = cap && (cap.em ?? cap.quando ?? cap)
  const quando = em ? new Date(em) : null
  const valido = quando && !isNaN(quando)
  $('pill-frescor').hidden = !valido
  if (valido) {
    const tz = { timeZone: 'America/Sao_Paulo' }
    const hora = quando.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', ...tz })
    // hora sem data parece recente: às 8h da manhã a pill dizia "mapa de 22:40"
    // e nada avisava que aquilo era da véspera
    const deHoje = quando.toLocaleDateString('sv-SE', tz) === hojeISO()
    $('pill-frescor').textContent = deHoje
      ? `mapa de ${hora}`
      : `mapa de ${quando.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', ...tz })}, ${hora}`
    $('pill-frescor').classList.toggle('pill-ouro', !deHoje)
    $('pill-frescor').classList.toggle('pill-fraco', deHoje)
  }
}

function falhaNoMapa({ vazio = false } = {}) {
  mapaCarregado = false
  pintarRelogio()                       // data e turno não dependem do servidor
  $('agora-falha').hidden = false
  $('agora-falha').firstChild.textContent = vazio
    ? 'O mapa de hoje ainda não chegou da planilha da faculdade. Ele é capturado ' +
      'de 20 em 20 minutos a partir das 5h. '
    : 'Não deu pra carregar o mapa de hoje. Se você está na rede da faculdade, ' +
      'ela pode estar bloqueando o servidor do app: tenta pelo 4G ou 5G. '
  $('livres-num').classList.remove('ghost-num')
  $('livres-num').textContent = '–'
  $('livres-rotulo').textContent = vazio
    ? 'o mapa de hoje ainda não chegou'
    : 'não deu pra saber quais salas estão livres'
  $('pill-livres').textContent = 'sem mapa'
  $('livres-grade').replaceChildren()
  $('board-agora').replaceChildren()
  $('agora-vazio').hidden = true
  $('busca-sem-mapa').hidden = false
  if (perfil) pintarHoje()
  toast(vazio ? 'O mapa de hoje ainda não chegou.' : 'Não deu pra carregar o mapa de hoje.')
}

on('btn-retry', 'click', (e) =>
  ocupado(e.currentTarget, () => (pronto = carregarAgora({ ghost: true }))))
// handler em JS, nunca onclick inline: a CSP não tem 'unsafe-inline' em
// script-src e handler inline morre calado (foi assim que a Inter não carregava)
on('btn-recarregar', 'click', () => location.reload())

// ── Trava do site (o botão do admin agora vale de verdade) ───────────────────
function aplicarTrava() {
  const bloqueado = cfg.travado === true && perfil?.role !== 'admin'
  const mudou = $('bloqueio').hidden === bloqueado
  $('bloqueio').hidden = !bloqueado
  document.body.classList.toggle('bloqueado', bloqueado)
  if (bloqueado && mudou) {
    window.scrollTo(0, 0)
    // o main some inteiro: sem isto o foco fica num botão que virou display:none
    $('bloqueio').querySelector('.bloqueio-card')?.focus({ preventScroll: true })
  }
}

// ── Planilha dinâmica ────────────────────────────────────────────────────────
let buscaTimer
// duas buscas em voo e a mais VELHA chegando depois sobrescreviam a nova: quem
// digitava "sist" e completava "sistemas embarcados" via a lista voltar
let seqBusca = 0
on('busca-input', 'input', (e) => {
  clearTimeout(buscaTimer)
  const termo = e.target.value.trim()
  buscaTimer = setTimeout(() => buscar(termo), 300)
})

on('btn-busca-retry', 'click', (e) =>
  ocupado(e.currentTarget, () => buscar($('busca-input').value.trim())))

// `sala_canon` entra: o placeholder promete busca por sala, mas só o rótulo cru
// da planilha era olhado, então procurar "P2-202" (o número que está na porta)
// não achava nada
const bate = (r, alvo) => [r.disciplina, r.professor, r.codigo, r.sala, r.sala_canon, r.turma]
  .some((v) => String(v ?? '').toLowerCase().includes(alvo))

const aspasPostgrest = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

async function buscar(termo) {
  const lista = $('busca-lista')
  $('busca-falha').hidden = true
  if (termo.length < 2) {
    lista.replaceChildren()
    $('busca-vazio').hidden = true
    $('busca-sem-mapa').hidden = true
    $('busca-dica').hidden = false
    return
  }
  $('busca-dica').hidden = true
  // sem o bundle não existe busca: antes disto a dica sumia ao digitar, o
  // `sb.from` lançava, e sobravam quatro esqueletos pulsando pra sempre
  if (!sb) {
    lista.replaceChildren()
    $('busca-vazio').hidden = true
    $('busca-falha').hidden = false
    return
  }
  ghostLinhas(lista, 4)
  const meu = ++seqBusca
  await pronto            // sem isto a primeira busca da sessão marca tudo "sem aula hoje"
  if (meu !== seqBusca) return

  const alvo = termo.toLowerCase()
  // 1) o mapa de hoje responde onde e quando, inclusive reserva sem código
  //    (evento no auditório não existe no catálogo, então nada achava)
  const deHoje = mapaHoje.filter((r) => bate(r, alvo))
  const vistos = new Set()
  const linhasHoje = []
  for (const r of deHoje) {
    const k = [r.horario, r.sala, r.disciplina, r.turma, r.professor].join('|')
    if (vistos.has(k)) continue
    vistos.add(k)
    linhasHoje.push(r)
  }
  linhasHoje.sort(porHorario)
  const codigosHoje = new Set(deHoje.map((r) => r.codigo).filter(Boolean))

  // 2) catálogo cobre quem não tem aula hoje (289 disciplinas contra 99 no mapa)
  // O `.or()` do PostgREST é montado como TEXTO, então vírgula, ponto e
  // parêntese digitados na busca mudavam a expressão do filtro (o mínimo era
  // erro 400 em quem buscasse "PA: INTRO, DIREITO"). Valor entre aspas resolve.
  const t = aspasPostgrest(`%${termo}%`)
  const { data, error } = await chamar(sb.from('disciplinas_historico')
    .select('codigo,turma,disciplina,professor')
    .or(`disciplina.ilike.${t},professor.ilike.${t},codigo.ilike.${t}`)
    .limit(30))
  if (meu !== seqBusca) return
  // o `return` seco deixava os quatro esqueletos pulsando pra sempre e o toast
  // sumia em 3,2s: o aluno ficava olhando um fantasma sem explicação nenhuma
  if (error) {
    lista.replaceChildren()
    $('busca-vazio').hidden = true
    $('busca-sem-mapa').hidden = true
    $('busca-falha').hidden = false
    return
  }
  const semAulaHoje = (data ?? []).filter((r) => !codigosHoje.has(r.codigo))
    .sort((a, b) => String(a.disciplina).localeCompare(String(b.disciplina), 'pt-BR'))

  const cards = [
    ...linhasHoje.map((r) => cardAula(r)),
    ...semAulaHoje.map((r) => cardCatalogo(r)),
  ]
  lista.removeAttribute('aria-busy')
  lista.replaceChildren(...cards)
  $('busca-status').textContent = cards.length
    ? `${cards.length} ${cards.length === 1 ? 'resultado' : 'resultados'}`
    : 'nada encontrado'
  $('busca-vazio').hidden = cards.length > 0
  // sem mapa carregado a busca NÃO afirma nada sobre hoje: dizer "sem aula hoje"
  // pra aula que está acontecendo é pior que dizer "não sei"
  $('busca-sem-mapa').hidden = mapaCarregado || cards.length === 0
}

// O chip mostra a sala CANÔNICA quando o repertório resolveu, e o rótulo cru da
// planilha desce pra meta. Rótulo cru pode ser gigante
// ("207 (P2) LAB.PROJETOS ELETRICOS/206 (P2)") e, dentro de um chip, engolia a
// linha inteira: a disciplina saía uma letra por linha no celular.
const chipSala = (r) => r.sala_canon || r.sala || '—'

function cardAula(r) {
  const el = li(`
    <span class="disc">${esc(r.disciplina || 'Reserva')}</span>
    <span class="sala">${esc(chipSala(r))}</span>
    <span class="meta">hoje · ${esc(r.horario)} · ${esc(r.turma)} · ${esc(r.professor)}</span>`)
  if (perfil && r.codigo) el.append(acoesAdicionar(r, { dia: agoraBRT().getDay() }))
  return el
}

function cardCatalogo(r) {
  const situacao = mapaCarregado ? 'sem aula hoje' : 'mapa de hoje indisponível'
  const el = li(`
    <span class="disc">${esc(r.disciplina)}</span>
    <span class="sala sala-vazia">—</span>
    <span class="meta">${situacao} · ${esc(r.turma)} · ${esc(r.professor)} · ${esc(r.codigo)}</span>`)
  if (perfil) el.append(acoesAdicionar(r))
  return el
}

function acoesAdicionar(r, { dia } = {}) {
  const acoes = document.createElement('span')
  acoes.className = 'acoes'
  const btn = document.createElement('button')
  btn.className = 'mini'

  if (dia) {
    // linha do mapa de hoje: o app JÁ sabe o dia, então não pergunta. O seletor
    // aqui era decoração que dava chance de errar
    btn.textContent = `Adicionar na ${DIAS[dia]}`
    btn.addEventListener('click', () => adicionarMateria(r, dia, btn))
    acoes.append(btn)
    return acoes
  }

  // catálogo: a disciplina não tem aula hoje, então o dia é a única coisa que o
  // app não tem como saber (o mapa guarda só o dia corrente)
  const sel = document.createElement('select')
  sel.className = 'mini'
  sel.setAttribute('aria-label', 'Dia da semana')
  sel.innerHTML = DIAS.map((d, i) => (i ? `<option value="${i}">${d}</option>` : '')).join('')
  btn.textContent = 'Adicionar'
  btn.addEventListener('click', () => adicionarMateria(r, +sel.value, btn))
  acoes.append(sel, btn)
  return acoes
}

// ── Conta ────────────────────────────────────────────────────────────────────
let sessao = null
let perfil = null
let perfilDesconhecido = false   // rede falhou: não dá pra afirmar que ele não tem conta
let intencao = 'entrar'

function aplicarIntencao(qual) {
  intencao = qual === 'criar' ? 'criar' : 'entrar'
  const criando = intencao === 'criar'
  $('conta-titulo').textContent = criando ? 'Criar sua conta' : 'Suas aulas, sua sala'
  $('conta-texto').textContent = criando
    ? 'Você entra com o Google, escolhe um username e monta suas matérias. Aí o IBSALA avisa a sala de cada aula antes do horário.'
    : 'Entre pra ver onde é sua próxima aula e receber aviso de sala antes de cada horário.'
  $('btn-login').textContent = criando ? 'Criar conta com Google' : 'Entrar com Google'
}

// Passo 1 é entrar, 2 é escolher username, 3 é ter pelo menos uma matéria.
// Some quando o cadastro termina, pra não virar enfeite permanente.
function pintarPassos() {
  const passo = !sessao ? 1 : (!perfil ? 2 : (minhas.length ? 0 : 3))
  $('passos').hidden = passo === 0
  for (const li of $('passos').children) {
    const n = Number(li.dataset.passo)
    li.classList.toggle('feito', n < passo)
    li.classList.toggle('atual', n === passo)
    if (n === passo) li.setAttribute('aria-current', 'step')
    else li.removeAttribute('aria-current')
  }
}

function mostrarConta() {
  const logado = !!(sessao && perfil)
  const cadastrando = !!(sessao && !perfil && !perfilDesconhecido)
  pintarPassos()
  $('cta-conta').hidden = logado         // logado não precisa ver "Criar conta"
  $('materias-cta').hidden = !logado
  $('conta-deslogado').hidden = !!sessao
  $('conta-cadastro').hidden = !cadastrando
  $('conta-falha').hidden = !(sessao && perfilDesconhecido)
  $('conta-logado').hidden = !logado
  // logado, os dois botões de conta colapsam num só
  $('btn-menu-entrar').textContent = logado ? `Minhas aulas (${perfil.username})` : 'Entrar'
  $('btn-menu-criar').hidden = logado
  if (cadastrando) {
    mostrar('conta')                     // volta do OAuth cai no passo pendente
    $('username-input').focus({ preventScroll: true })
  }
}

// A tela guardava a lista de matérias e, no admin, o email de todos os alunos.
// Sair não limpava nada disso do DOM até o próximo login.
function limparDadosNaTela() {
  for (const id of ['lista-materias', 'board-hoje', 'admin-alunos', 'admin-reclamacoes']) {
    $(id).replaceChildren()
  }
  $('bloco-admin').hidden = true
}

async function carregarPerfil() {
  if (!sessao) {
    perfil = null
    perfilDesconhecido = false
    limparDadosNaTela()
    mostrarConta()
    aplicarTrava()
    return
  }
  const { data, error } = await chamar(sb.from('alunos')
    .select('id,username,email,role,bloqueado,receber_email')
    .eq('id', sessao.user.id).maybeSingle())

  // "não tenho perfil" é diferente de "não sei se tenho perfil". Com o erro
  // tratado como ausência, uma falha de rede convidava quem já tem conta a
  // criar outra, e ainda arrancava a pessoa da tela em que ela estava.
  perfilDesconhecido = !!error
  if (error) { mostrarConta(); toast(error.msg); return }

  perfil = data
  mostrarConta()
  aplicarTrava()
  if (perfil) {
    abrirNasAulasDoDia()
    tocarUltimoAcesso()
    carregarMinhas()
    atualizarBotaoPush()
    $('novo-username').value = perfil.username
    $('ajustes-email').textContent = `Entrando com o Google, como ${perfil.email}.`
    $('chk-email').checked = perfil.receber_email !== false
    const adm = perfil.role === 'admin'
    $('bloco-admin').hidden = !adm
    $('btn-abrir-admin').hidden = !adm
    if (adm) carregarAdmin()
  }
}

// A tela inicial é decidida no boot a partir do hash, ANTES de a sessão existir
// (ela só chega no onAuthStateChange), e sem hash o boot não chama mostrar()
// nenhum: valia o `ativa` do HTML, que é a home. Quem já tinha conta abria o app
// numa tela de apresentação e gastava mais um toque pra ver a aula do dia.
// Três guardas, cada uma por um motivo concreto: `roteouLogado` porque o
// onAuthStateChange dispara de novo a cada refresh de token; `HASH_NO_BOOT`
// porque `/#agora` e `/#buscar` são atalhos do manifest e link colado no zap;
// e `telaAtual === 'home'` porque o perfil pode chegar depois de a pessoa já ter
// tocado num botão, e arrancar alguém da tela é pior que um toque a mais.
function abrirNasAulasDoDia() {
  if (roteouLogado || HASH_NO_BOOT || telaAtual !== 'home') return
  roteouLogado = true
  mostrar('conta', { push: false })
  history.replaceState({ tela: 'conta' }, '', '#conta')
}

// A 0001 promete "throttle fica no client; smart-write do v1 era 6h" e esse
// throttle nunca existiu: escrevia a cada evento de auth, inclusive no refresh
// de token de hora em hora.
function tocarUltimoAcesso() {
  const chave = 'ibsala:ultimo-acesso'
  try {
    const ultimo = Number(localStorage.getItem(chave) ?? 0)
    if (Date.now() - ultimo < 6 * 60 * 60 * 1000) return
    localStorage.setItem(chave, String(Date.now()))
  } catch { /* localStorage bloqueado (navegação privada): toca do mesmo jeito */ }
  chamar(sb.rpc('touch_ultimo_acesso'))
}

// ── Push (avisos de sala) ────────────────────────────────────────────────────
const ehIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const naTelaDeInicio = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true

function b64ParaUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

async function subAtual() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null
  const reg = await navigator.serviceWorker.ready
  return reg.pushManager.getSubscription()
}

// o switch mostra ESTADO. O botão anterior descrevia a próxima ação
// ("Desativar avisos"), e pra saber se estava ligado o aluno tinha que ler.
async function atualizarBotaoPush() {
  const chk = $('chk-push')
  const rotulo = $('push-rotulo')
  const dica = $('push-dica')
  // mesma classe de falha do `on()`: HTML velho com JS novo derruba aqui também,
  // e uma promise rejeitada no meio do carregamento do perfil não ajuda ninguém
  if (!chk || !rotulo || !dica) return

  if (!('PushManager' in window)) {
    chk.disabled = true
    chk.checked = false
    rotulo.textContent = 'Avisos não suportados neste navegador'
    // a dica continuava prometendo "você recebe a sala ~50 min antes", que é o
    // contrário do que o rótulo acabou de dizer
    dica.textContent = 'Este navegador não entrega notificação. No iPhone, use o ' +
      'Safari com o app na Tela de Início; no computador, Chrome, Edge ou Firefox.'
    return
  }
  // no iPhone o subscribe só funciona com o app na Tela de Início, e sem dizer
  // isso o aluno toca, falha e não entende
  if (ehIOS && !naTelaDeInicio()) {
    chk.disabled = true
    chk.checked = false
    rotulo.textContent = 'Avisos exigem o app na Tela de Início'
    dica.textContent = 'No iPhone: botão Compartilhar do Safari → "Adicionar à Tela de Início". ' +
      'Abra o IBSALA por esse ícone e o interruptor destrava.'
    return
  }
  chk.disabled = false
  rotulo.textContent = 'Avisos neste aparelho'
  dica.textContent = 'Você recebe a sala de cada aula ~50 minutos antes do horário.'

  // O interruptor lia só o PushManager do navegador. Quando a linha sumia do
  // banco (o push-slot apaga a inscrição no 410) o aluno via "ligado", confiava,
  // e não recebia aviso nenhum: o app afirmando com confiança o que não sabia.
  const sub = await subAtual()
  chk.checked = !!sub && !!(await chamar(sb.from('push_subscriptions')
    .select('endpoint').eq('endpoint', sub.endpoint).maybeSingle())).data
}

async function salvarInscricao(sub) {
  const j = sub.toJSON()
  return chamar(sb.from('push_subscriptions').upsert({
    aluno_id: sessao.user.id, endpoint: j.endpoint,
    p256dh: j.keys.p256dh, auth: j.keys.auth,
  }, { onConflict: 'endpoint' }))
}

on('chk-push', 'change', async (e) => {
  const chk = e.target
  const querLigar = chk.checked

  // requestPermission ANTES de qualquer await: o Safari só aceita o pedido
  // dentro da tarefa do gesto, e esperar o serviceWorker.ready quebrava isso
  const pedido = querLigar && Notification.permission === 'default'
    ? Notification.requestPermission()
    : Promise.resolve(Notification.permission)

  chk.disabled = true
  try {
    const sub = await subAtual()

    if (!querLigar) {
      if (sub) {
        const { error } = await chamar(sb.from('push_subscriptions')
          .delete().eq('endpoint', sub.endpoint))
        if (error) { toast(error.msg); return }
        await sub.unsubscribe()
      }
      toast('Avisos desativados.')
      return
    }

    // inscrição do navegador já existe: pode ser que ela só tenha sumido do
    // banco, e aí o certo é gravar de novo, não sair calado
    if (sub) {
      const { error } = await salvarInscricao(sub)
      toast(error ? error.msg : 'Avisos ativados neste aparelho.')
      return
    }
    const perm = await pedido
    if (perm !== 'granted') { toast('Permissão de notificação negada.'); return }
    const reg = await navigator.serviceWorker.ready
    const nova = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ParaUint8(VAPID_PUBLIC_KEY),
    })
    const { error } = await salvarInscricao(nova)
    if (error) { toast(error.msg); await nova.unsubscribe(); return }
    toast('Avisos ativados neste aparelho.')
  } finally {
    chk.disabled = false
    // o switch nunca fica mentindo: o estado final vem do que existe de fato
    atualizarBotaoPush()
  }
})

// ── Ajustes ──────────────────────────────────────────────────────────────────
for (const b of $('tema').children) {
  b.addEventListener('click', () => {
    const escolha = aplicarTema(b.dataset.tema)
    pintarTema(escolha)
  })
}
function pintarTema(escolha) {
  for (const b of $('tema').children) {
    const ativo = b.dataset.tema === escolha
    b.classList.toggle('ativo', ativo)
    b.setAttribute('aria-checked', String(ativo))
  }
}
pintarTema(temaGuardado())

$('ajustes-versao').textContent = `IBSALA v5 · termos versão ${TERMOS_VERSAO}`

on('form-trocar-username', 'submit', (e) => {
  e.preventDefault()
  const btn = e.target.querySelector('button')
  return ocupado(btn, async () => {
    const u = $('novo-username').value.trim()
    $('username-troca-erro').hidden = true
    if (u === perfil?.username) { toast('Esse já é o seu username.'); return }

    const { data: livre, error: eCheca } = await chamar(
      sb.rpc('username_disponivel', { candidato: u }))
    if (eCheca) { mostrarErro('username-troca-erro', eCheca.msg); return }
    if (!livre) { mostrarErro('username-troca-erro', 'Esse username já existe. Tenta outro.'); return }

    const { error } = await chamar(sb.from('alunos')
      .update({ username: u }).eq('id', sessao.user.id))
    if (error) {
      mostrarErro('username-troca-erro', error.tipo === 'duplicado'
        ? 'Esse username já existe. Tenta outro.' : error.msg)
      return
    }
    toast(`Agora você é ${u}.`)
    carregarPerfil()
  })
})

// `receber_email` existe no schema desde a 0001 e NUNCA foi exposto nem lido:
// o app manda email e o aluno não tinha como desligar
on('chk-email', 'change', (e) => {
  const chk = e.target
  const quer = chk.checked
  return ocupado(chk, async () => {
    const { error } = await chamar(sb.from('alunos')
      .update({ receber_email: quer }).eq('id', sessao.user.id))
    if (error) { chk.checked = !quer; toast(error.msg); return }
    perfil.receber_email = quer
    toast(quer ? 'Você volta a receber email do IBSALA.' : 'Emails desligados.')
  })
})

function mostrarErro(id, msg) {
  $(id).textContent = msg
  $(id).hidden = !msg
}

// ── Reclamações / dados (LGPD) ───────────────────────────────────────────────
on('form-reclamacao', 'submit', (e) => {
  e.preventDefault()
  const btn = e.target.querySelector('button')
  return ocupado(btn, async () => {
    const desc = $('reclamacao-input').value.trim()
    if (!desc) return
    const { error } = await chamar(sb.from('reclamacoes').insert({
      aluno_id: sessao.user.id, descricao: desc,
    }))
    toast(error ? error.msg : 'Reclamação enviada. Valeu!')
    if (!error) $('reclamacao-input').value = ''
  })
})

on('btn-export', 'click', (ev) => ocupado(ev.currentTarget, async () => {
  const { data, error } = await chamar(sb.rpc('exportar_meus_dados'))
  if (error) { toast(error.msg); return }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `ibsala-dados-${hojeISO()}.json`
  a.style.display = 'none'
  // o Safari precisa do link no DOM, e revogar na hora cancela o download
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  // sem confirmação, quem não visse o download aparecer tocava cinco vezes
  toast('Arquivo com seus dados gerado.')
}))

on('btn-excluir', 'click', () => {
  $('excluir-confirma').hidden = false
  $('btn-excluir-confirma').focus()
})
on('btn-excluir-cancela', 'click', () => {
  $('excluir-confirma').hidden = true
  $('btn-excluir').focus()
})
on('btn-excluir-confirma', 'click', (ev) => ocupado(ev.currentTarget, async () => {
  const { error } = await chamar(sb.functions.invoke('apagar-conta'), 20000)
  if (error) { toast('Exclusão falhou. Tenta de novo.'); return }
  // se o signOut remoto falhar, a sessão de uma conta que não existe mais fica
  // no aparelho e TODA query passa a falhar em silêncio
  await sb.auth.signOut().catch(() => sb.auth.signOut({ scope: 'local' }))
  $('excluir-confirma').hidden = true
  mostrar('home')
  toast('Conta e dados excluídos.')
}))

// ── Admin ────────────────────────────────────────────────────────────────────
async function carregarAdmin() {
  const [conf, recs, todos] = await Promise.all([
    chamar(sb.from('config').select('value').eq('key', 'travado').single()),
    chamar(sb.from('reclamacoes').select('id,descricao,criado,alunos(username)')
      .is('resolvido_em', null).order('criado')),
    chamar(sb.from('alunos').select('id,username,email,role,bloqueado').order('criado')),
  ])

  // o painel dizia "nenhuma reclamação aberta" quando a query tinha falhado, e
  // a lista de alunos ficava vazia sem explicação
  const falhou = conf.error || recs.error || todos.error
  $('admin-falha').hidden = !falhou
  if (falhou) return

  const travado = conf.data?.value === true
  $('btn-trava').hidden = false
  $('btn-trava').textContent = travado ? 'Destravar o site' : 'Travar o site'
  $('btn-trava').onclick = () => ocupado($('btn-trava'), async () => {
    const { error } = await chamar(
      sb.from('config').update({ value: !travado }).eq('key', 'travado'))
    // o estado local era mutado ANTES de saber se o servidor aceitou: o admin
    // via a tela mudar e achava que tinha travado o site enquanto todo mundo
    // seguia navegando
    if (error) { toast(error.msg); return }
    cfg.travado = !travado
    aplicarTrava()
    carregarAdmin()
  })

  const lr = $('admin-reclamacoes')
  lr.replaceChildren(...(recs.data ?? []).map((r) => {
    const el = li(`
      <span class="disc">${esc(r.descricao)}</span>
      <span class="meta">${esc(r.alunos?.username ?? '?')} · ${new Date(r.criado).toLocaleString('pt-BR')}</span>`)
    const acoes = document.createElement('span')
    acoes.className = 'acoes'
    const btn = document.createElement('button')
    btn.className = 'mini'
    btn.textContent = 'Resolver'
    btn.addEventListener('click', () => ocupado(btn, async () => {
      const { error } = await chamar(sb.from('reclamacoes')
        .update({ resolvido_em: new Date().toISOString() }).eq('id', r.id))
      if (error) { toast(error.msg); return }
      carregarAdmin()
    }))
    acoes.append(btn)
    el.append(acoes)
    return el
  }))
  $('admin-reclamacoes-vazio').hidden = (recs.data ?? []).length > 0
  $('admin-alunos-vazio').hidden = (todos.data ?? []).length > 0

  const la = $('admin-alunos')
  la.replaceChildren(...(todos.data ?? []).map((a) => {
    const el = li(`
      <span class="disc">${esc(a.username)}${a.role === 'admin' ? ' · admin' : ''}</span>
      <span class="meta">${esc(a.email)}${a.bloqueado ? ' · BLOQUEADO' : ''}</span>`)
    if (a.role !== 'admin') {
      const acoes = document.createElement('span')
      acoes.className = 'acoes'
      const btn = document.createElement('button')
      btn.className = 'mini'
      btn.textContent = a.bloqueado ? 'Desbloquear' : 'Bloquear'
      btn.addEventListener('click', () => ocupado(btn, async () => {
        const { error } = await chamar(sb.from('alunos')
          .update({ bloqueado: !a.bloqueado }).eq('id', a.id))
        if (error) { toast(error.msg); return }
        toast(a.bloqueado ? 'Aluno desbloqueado.' : 'Aluno bloqueado.')
        carregarAdmin()
      }))
      acoes.append(btn)
      el.append(acoes)
    }
    return el
  }))
}

on('btn-login', 'click', (ev) => ocupado(ev.currentTarget, async () => {
  if (!sb) { toast('O app não carregou por completo. Recarrega a página.'); return }
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname },
  })
  // "não configurado" era a frase pra QUALQUER erro, inclusive rede caída
  if (error) toast('Não deu pra abrir o login do Google. Tenta de novo.')
}))

on('btn-sair', 'click', (ev) => ocupado(ev.currentTarget, async () => {
  const { error } = await sb.auth.signOut()
  toast(error ? 'Não deu pra sair. Tenta de novo.' : 'Você saiu.')
}))

on('btn-conta-retry', 'click', (ev) =>
  ocupado(ev.currentTarget, () => carregarPerfil()))

on('btn-cancelar-cadastro', 'click', (ev) => ocupado(ev.currentTarget, async () => {
  await sb.auth.signOut().catch(() => sb.auth.signOut({ scope: 'local' }))
  mostrar('home')
  toast('Cadastro cancelado.')
}))

on('form-username', 'submit', (e) => {
  e.preventDefault()
  const btn = e.target.querySelector('button')
  return ocupado(btn, async () => {
    const u = $('username-input').value.trim()
    mostrarErroUsername('')
    if (!$('chk-termos').checked) {
      mostrarErroUsername('Pra criar a conta você precisa aceitar os termos e a política.')
      $('chk-termos').focus()
      return
    }

    const { data: livre, error: eChecagem } = await chamar(
      sb.rpc('username_disponivel', { candidato: u }))
    // o erro era descartado e `livre` virava undefined, ou seja falsy: rede
    // oscilando dizia "esse username já existe" pra todo nome que ele tentasse,
    // e o cadastro morria aí
    if (eChecagem) { mostrarErroUsername(eChecagem.msg); return }
    if (!livre) { mostrarErroUsername('Esse username já existe. Tenta outro.'); return }

    const { error } = await chamar(sb.from('alunos').insert({
      id: sessao.user.id, username: u, email: sessao.user.email,
      // prova do aceite: data e versão, não só um checkbox que sumiu da tela
      termos_em: new Date().toISOString(), termos_versao: TERMOS_VERSAO,
    }))
    if (error) {
      mostrarErroUsername(error.tipo === 'duplicado'
        ? 'Esse username já existe. Tenta outro.' : error.msg)
      return
    }
    toast(`Bem-vindo/a, ${u}! Agora monte sua grade.`)
    await carregarPerfil()
    // passo 3 é onde o app começa a servir pra alguma coisa; sem empurrão, 7
    // dos 17 cadastrados pararam exatamente aqui
    if (!minhas.length) mostrar('buscar')
  })
})

// erro do cadastro fica ao lado do campo. Em toast ele sumia em 3,2 segundos,
// no canto da tela, no passo mais importante do app
function mostrarErroUsername(msg) {
  mostrarErro('username-erro', msg)
}

async function carregarMinhas() {
  ghostLinhas($('lista-materias'), 3)
  ghostLinhas($('board-hoje'), 2)
  // filtro explicito por aluno: a policy de materias é
  // `aluno_id = auth.uid() OR is_admin()`, então admin sem WHERE enxerga a
  // matéria de TODO MUNDO e "Minhas matérias" listava as 79 dos 18 alunos
  const { data, error } = await chamar(sb.from('materias')
    .select('id,dia,turma,disciplina,professor,codigo')
    .eq('aluno_id', sessao.user.id)
    .order('dia').order('disciplina'))

  // o `return` seco deixava as DUAS listas em esqueleto pra sempre, sem
  // mensagem e sem botão, na tela mais importante do aluno logado
  if (error) {
    $('lista-materias').replaceChildren()
    $('board-hoje').replaceChildren()
    $('materias-vazio').hidden = true
    $('hoje-vazio').hidden = true
    $('materias-falha').hidden = false
    return
  }
  $('materias-falha').hidden = true
  minhas = data ?? []

  $('lista-materias').removeAttribute('aria-busy')
  $('board-hoje').removeAttribute('aria-busy')
  $('lista-materias').replaceChildren(...agruparMaterias(minhas).map(blocoMateria))
  $('materias-vazio').hidden = minhas.length > 0
  pintarPassos()
  pintarHoje()
}

// `materias` guarda uma linha por (aluno, código, dia), então Estrutura de Dados
// cursada na SEG e na QUA aparecia duas vezes na lista, cada cópia com sua
// pílula e seu botão de remover. O agrupamento é só de apresentação: o banco
// continua com uma linha por dia, e é por isso que `pintarHoje` não muda.
function agruparMaterias(linhas) {
  const grupos = new Map()
  for (const m of linhas) {
    // código é a chave única da disciplina; linha antiga sem código cai no par
    // disciplina+turma, que era o dedupe do v1
    const chave = m.codigo || `${m.disciplina}|${m.turma}`
    if (!grupos.has(chave)) grupos.set(chave, { ...m, dias: [] })
    grupos.get(chave).dias.push({ id: m.id, dia: m.dia })
  }
  const lista = [...grupos.values()]
  for (const g of lista) g.dias.sort((a, b) => a.dia - b.dia)
  // a query vem ordenada por dia e depois disciplina, o que embaralhava a lista
  // agrupada (a matéria da segunda subia na frente por causa do dia, não do nome)
  lista.sort((a, b) => String(a.disciplina).localeCompare(String(b.disciplina), 'pt-BR'))
  return lista
}

function blocoMateria(g) {
  const el = li(`
    <span class="disc">${esc(g.disciplina)}</span>
    <span class="meta">${esc(g.turma)} · ${esc(g.professor ?? '')} · ${esc(g.codigo)}</span>`)

  const dias = document.createElement('span')
  dias.className = 'dias'
  for (const d of g.dias) {
    const pill = document.createElement('button')
    pill.type = 'button'
    pill.className = 'pill-dia'
    pill.setAttribute('aria-label', `Tirar ${DIAS_LONGO[d.dia] ?? ''} de ${g.disciplina}`)
    pill.append(DIAS[d.dia] ?? '?')
    const x = document.createElement('span')
    x.className = 'pill-x'
    x.setAttribute('aria-hidden', 'true')
    x.textContent = '×'
    pill.append(x)
    pill.addEventListener('click', () => ocupado(pill, async () => {
      const { error } = await chamar(sb.from('materias').delete()
        .eq('id', d.id).eq('aluno_id', sessao.user.id))
      // sem checar erro, a lista recarregava idêntica e o dia continuava lá sem
      // ninguém explicar por quê
      if (error) { toast(error.msg); return }
      toast(`${DIAS[d.dia]} tirada de ${g.disciplina}.`)
      carregarMinhas()
    }))
    dias.append(pill)
  }

  const acoes = document.createElement('span')
  acoes.className = 'acoes'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'mini'
  btn.textContent = 'Remover'
  // com o bloco único, um toque apaga a matéria em TODOS os dias, e isso pede
  // confirmação. `confirm()` nativo não serve: a CSP do projeto já pune diálogo
  // inline e na PWA do iPhone ele interrompe o app inteiro. A confirmação é o
  // próprio botão, e ela expira sozinha em 4s pra não ficar armada na tela.
  let armado = null
  const desarmar = () => {
    clearTimeout(armado)
    armado = null
    btn.textContent = 'Remover'
    btn.classList.remove('perigo')
  }
  btn.addEventListener('click', () => {
    if (!armado) {
      btn.textContent = 'Remover mesmo?'
      btn.classList.add('perigo')
      armado = setTimeout(desarmar, 4000)
      return
    }
    desarmar()
    ocupado(btn, async () => {
      const { error } = await chamar(sb.from('materias').delete()
        .in('id', g.dias.map((d) => d.id)).eq('aluno_id', sessao.user.id))
      if (error) { toast(error.msg); return }
      toast('Matéria removida.')
      carregarMinhas()
    })
  })
  acoes.append(btn)

  el.append(dias, acoes)
  return el
}

// Separado de carregarMinhas porque o "Hoje" depende de DUAS cargas (as
// matérias e o mapa) e o login costuma ganhar do mapa: montando tudo junto, a
// tela dizia "sem sala no mapa de hoje" em todas as matérias e nunca mais se
// corrigia, nem quando o mapa chegava três segundos depois.
function pintarHoje() {
  const board = $('board-hoje')
  const hoje = agoraBRT().getDay()
  const deHoje = minhas.filter((m) => m.dia === hoje)

  // "Hoje" é uma agenda, então ordena por HORÁRIO, não por nome de disciplina:
  // a query vem por `disciplina` e isso punha a aula de 09:50 antes da de 07:30.
  // A mesma disciplina pode ter duas sessões no dia; pegar só a primeira
  // escondia a segunda sala.
  const linhasHoje = deHoje.flatMap((m) => {
    const aulas = mapaHoje.filter((r) => (m.codigo && r.codigo === m.codigo) ||
      (!m.codigo && r.disciplina === m.disciplina))
    if (!aulas.length) return [{ m, aula: null, ini: Infinity }]
    return aulas.map((a) => ({ m, aula: a, ini: faixaHoraria(a.horario)?.[0] ?? Infinity }))
  })
  // sem horário conhecido vai pro fim, e empate desempata por disciplina
  linhasHoje.sort((a, b) => a.ini - b.ini || a.m.disciplina.localeCompare(b.m.disciplina, 'pt-BR'))

  board.replaceChildren(...linhasHoje.map(({ m, aula }) => (aula
    ? li(`
      <span class="disc">${esc(m.disciplina)}</span>
      <span class="sala">${esc(chipSala(aula))}</span>
      <span class="meta">${esc(aula.horario)} · ${esc(m.turma)}</span>`)
    : li(`
      <span class="disc">${esc(m.disciplina)}</span>
      <span class="sala sala-vazia" aria-label="sala desconhecida">—</span>
      <span class="meta">${mapaCarregado ? 'sem sala no mapa de hoje'
        : 'mapa de hoje indisponível'} · ${esc(m.turma)}</span>`))))
  $('hoje-vazio').hidden = deHoje.length > 0
}

async function adicionarMateria(r, dia, btn) {
  return ocupado(btn, async () => {
    const { error } = await chamar(sb.from('materias').insert({
      aluno_id: sessao.user.id, dia,
      turma: r.turma ?? '', disciplina: r.disciplina, professor: r.professor, codigo: r.codigo,
    }))
    // toda falha virava "você já tem essa matéria nesse dia", inclusive sessão
    // expirada: o aluno acreditava, ia conferir e não estava lá
    if (error) {
      toast(error.tipo === 'duplicado' ? `Você já tem essa matéria na ${DIAS[dia]}.` : error.msg)
      return
    }
    toast(`Adicionada na ${DIAS[dia]}.`)
    carregarMinhas()
  })
}

// ── Init ─────────────────────────────────────────────────────────────────────
aplicarIntencao('entrar')
const telaInicial = location.hash.replace('#', '')
history.replaceState({ tela: TELAS.includes(telaInicial) ? telaInicial : 'home' }, '', location.hash || '#')
if (TELAS.includes(telaInicial) && telaInicial !== 'home') mostrar(telaInicial, { push: false })

procurarAtualizacao()
pintarRelogio()          // cabeçalho vivo desde o primeiro quadro, sem esperar rede

if (!sb) {
  // bundle do supabase-js não chegou: em vez de a tela ficar muda com "–" e o
  // aluno achar que o app está quebrado, diz o que houve e oferece recarregar
  $('livres-num').classList.remove('ghost-num')
  $('agora-falha').hidden = false
  $('agora-falha').firstChild.textContent =
    'Não deu pra carregar a biblioteca do app. Se você está numa rede que filtra ' +
    'endereços, pode ser isso. '
  $('busca-dica').textContent = 'Busca fora do ar até a página carregar por completo.'
  $('busca-falha').hidden = false
  // a conta ficava em branco: os três blocos nascem hidden e quem destrava é o
  // onAuthStateChange, que sem bundle nunca é registrado
  $('conta-falha').hidden = false
  $('conta-falha').firstChild.textContent =
    'O app não carregou por completo, então não dá pra entrar agora. Se você está ' +
    'numa rede que filtra endereços, tenta pelo 4G. '
  $('conta-deslogado').hidden = true
  $('btn-retry').onclick = () => location.reload()
} else {
  sb.auth.onAuthStateChange((_ev, s) => {
    sessao = s
    carregarPerfil()
  })

  pronto = carregarAgora({ ghost: true })
  setInterval(() => carregarAgora(), 5 * 60 * 1000)
  setInterval(() => (mapaCarregado ? pintarAgora() : pintarRelogio()), 60 * 1000)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return
    carregarAgora()          // PWA retomada não mostra número da véspera
    procurarAtualizacao()    // nem versão da véspera
  })
  window.addEventListener('online', () => { carregarAgora(); procurarAtualizacao() })
}

// última linha de propósito: se algo acima lançar, esta marca não aparece, e é
// exatamente esse o estado que deixou a página pintada e sem NENHUM botão
// funcionando em 12/08. `incompleto` é o caso mais brando, em que o módulo foi
// até o fim mas algum id do HTML não existe: a página funciona quase toda, e
// sem este aviso ninguém ficaria sabendo (o aluno só vê um botão que não faz
// nada). O `?.` duplo é pro loader do Sentry bloqueado (firewall da faculdade,
// bloqueador de anúncio) não virar um segundo erro em cima do primeiro.
if (faltando.length) {
  document.documentElement.dataset.app = 'incompleto'
  window.Sentry?.captureMessage?.(`ids ausentes no DOM: ${faltando.join(', ')}`, 'error')
} else {
  document.documentElement.dataset.app = 'pronto'
}
