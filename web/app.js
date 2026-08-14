// `?v=` no import também: a query do `<script>` não é herdada pelo import
// estático, e config.js carrega a chave VAPID. O número acompanha o CACHE do
// sw.js e é verificado por scripts/versao.py.
import { SUPABASE_URL, SUPABASE_KEY, VAPID_PUBLIC_KEY } from './config.js?v=38'

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
const TELAS = ['home', 'agora', 'buscar', 'materias', 'conta', 'ajustes', 'admin']
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

// ── Casca da última sessão ───────────────────────────────────────────────────
// Abrir o app era uma sequência de solavancos: o menu nascia com quatro botões e
// perdia o "Criar conta" quando a sessão resolvia, a pill de alunos aparecia do
// nada e empurrava a linha, e o número de livres pulava de "—" pro valor. Tudo
// isso é dado que o aparelho JÁ VIU na última visita. Guardar o último valor e
// pintar a tela com ele, borrado, no primeiro quadro, deixa o tamanho final
// pronto antes de a rede responder: quando o dado chega, o borrado sai e nada se
// mexe. Borrado, e não nítido, porque o valor é do passado até a rede confirmar.
const CASCA_CHAVE = 'ibsala:casca'
function lerCasca() {
  try { return JSON.parse(localStorage.getItem(CASCA_CHAVE) ?? '{}') ?? {} } catch { return {} }
}
function gravarCasca(campos) {
  try { localStorage.setItem(CASCA_CHAVE, JSON.stringify({ ...lerCasca(), ...campos })) } catch { /* privada */ }
}
// pill que mostra valor da última sessão: sai do vulto quando o dado de verdade
// chega, com a mesma transição do menu da home
function vulto(id, ligado) {
  $(id)?.classList.toggle('vulto', ligado)
}

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

// telas que só existem pra quem tem conta: digitar #ajustes deslogado abria uma
// tela de configurações vazia, sem dizer por quê. `materias` entra pelo mesmo
// motivo: adicionar disciplina sem sessão é insert que o banco recusa.
const TELAS_LOGADO = ['ajustes', 'materias', 'admin']

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

// Ocupada é sobreposição de horário com a janela do turno, não "o turno do
// primeiro horário" (o porquê está em intervaloCobreSlot).
function livresNoSlot(chave) {
  const s = SLOTS[chave]
  if (!s) return []
  const ocupadas = new Set(mapaHoje
    .filter((r) => r.sala_canon && intervaloCobreSlot(r.horario, s))
    .map((r) => r.sala_canon))
  return salas.filter((x) => !ocupadas.has(x.sala))
}

// chips agrupados por prédio, e TODOS: cortar em 40 sem avisar escondia sala
function chipsPorPredio(livres) {
  const predios = [...new Set(livres.map((s) => s.predio))].sort()
  return predios.flatMap((p) => {
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
  })
}

// O app só sabia responder "agora", e quem procura onde estudar às 19h tinha que
// esperar as 19h pra descobrir. O interruptor abre um bloco por turno que ainda
// vem hoje, com a conta e as salas de cada um. Sai tudo de `mapaHoje` e `salas`,
// que já estão na memória: nenhuma consulta nova.
const DIA_TODO_CHAVE = 'ibsala:dia-todo'
function pintarTurnos() {
  const box = $('livres-turnos')
  const ligado = !!$('chk-dia-todo')?.checked
  box.hidden = !ligado
  if (!ligado || !mapaCarregado) { box.replaceChildren(); return }

  const atual = slotAtual()
  const chaves = Object.keys(SLOTS)
  // fora de horário de aula o "resto do dia" começa no próximo turno; depois do
  // último, não há resto nenhum e dizer isso é melhor que uma lista vazia
  const inicio = atual ?? proximoSlot(minutosAgora())?.k
  const daqui = inicio ? chaves.slice(chaves.indexOf(inicio)) : []
  if (!daqui.length) {
    const p = document.createElement('p')
    p.className = 'vazio'
    p.textContent = 'As aulas de hoje acabaram. Isto volta a valer amanhã de manhã.'
    box.replaceChildren(p)
    return
  }

  box.replaceChildren(...daqui.flatMap((k) => {
    const livres = livresNoSlot(k)
    const cabeca = document.createElement('p')
    cabeca.className = 'turno-cabeca'
    cabeca.textContent = `${SLOTS[k].label}${k === atual ? ' (agora)' : ''} · ` +
      `${livres.length} ${livres.length === 1 ? 'livre' : 'livres'}`
    if (!livres.length) {
      const p = document.createElement('p')
      p.className = 'vazio'
      p.textContent = 'Nenhuma sala livre neste turno.'
      return [cabeca, p]
    }
    const grade = document.createElement('div')
    grade.className = 'grade-salas'
    grade.replaceChildren(...chipsPorPredio(livres))
    return [cabeca, grade]
  }))
}

function pintarAgora() {
  pintarRelogio()
  const slot = slotAtual()
  const min = minutosAgora()

  const livres = slot ? livresNoSlot(slot) : []

  $('livres-num').classList.remove('ghost-num')
  $('livres-num').textContent = slot ? livres.length : '–'
  $('livres-rotulo').textContent = slot
    ? `salas livres no ${SLOTS[slot].label.toLowerCase()}`
    : 'fora do horário de aulas'
  $('pill-livres').textContent = slot ? `${livres.length} livres` : `${salas.length} salas`
  vulto('pill-livres', false)
  if (slot) gravarCasca({ livres: livres.length })

  const grade = $('livres-grade')
  $('livres-vazio').hidden = !slot || livres.length > 0
  grade.replaceChildren(...chipsPorPredio(livres))
  pintarTurnos()

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
    vulto('pill-alunos', false)
    gravarCasca({ alunos: totalAlunos })
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
    vulto('pill-frescor', false)
    gravarCasca({ frescor: $('pill-frescor').textContent })
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
  // sem mapa, sala nenhuma pode ser dita livre: as seções por turno somem junto
  pintarTurnos()
  $('board-agora').replaceChildren()
  $('agora-vazio').hidden = true
  $('busca-sem-mapa').hidden = false
  if (perfil) pintarHoje()
  toast(vazio ? 'O mapa de hoje ainda não chegou.' : 'Não deu pra carregar o mapa de hoje.')
}

// escolha de tela, então mora no aparelho, igual ao tema
try { $('chk-dia-todo').checked = localStorage.getItem(DIA_TODO_CHAVE) === '1' } catch { /* privada */ }
on('chk-dia-todo', 'change', (e) => {
  try { localStorage.setItem(DIA_TODO_CHAVE, e.target.checked ? '1' : '0') } catch { /* privada */ }
  pintarTurnos()
})

on('btn-retry', 'click', (e) =>
  ocupado(e.currentTarget, () => (pronto = carregarAgora({ ghost: true }))))
// handler em JS, nunca onclick inline: a CSP não tem 'unsafe-inline' em
// script-src e handler inline morre calado (foi assim que a Inter não carregava).
// Por atributo e não por id porque agora são dois botões iguais, um em cada tela
// de busca, e `on()` só alcança um id por vez.
document.querySelectorAll('[data-recarregar]').forEach((b) =>
  b.addEventListener('click', () => location.reload()))

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

// ── Busca na planilha (duas telas, um motor) ─────────────────────────────────
// A mesma busca serve a Planilha dinâmica (consulta pura) e a Adicionar
// disciplinas (monta a grade). O que separa as duas é `adicionar`: sem ele o
// resultado não ganha pílula de dia nem botão, e a tela vira só leitura.
// Cada tela tem seu contador de sequência, senão digitar numa cancela a outra.
const BUSCAS = {
  buscar: {
    input: 'busca-input', retry: 'btn-busca-retry', lista: 'busca-lista',
    dica: 'busca-dica', falha: 'busca-falha', semMapa: 'busca-sem-mapa',
    vazio: 'busca-vazio', status: 'busca-status', adicionar: false, seq: 0,
  },
  materias: {
    input: 'adicionar-input', retry: 'btn-adicionar-retry', lista: 'adicionar-lista',
    dica: 'adicionar-dica', falha: 'adicionar-falha', semMapa: 'adicionar-sem-mapa',
    vazio: 'adicionar-vazio', status: 'adicionar-status', adicionar: true, seq: 0,
  },
}

for (const tela of Object.values(BUSCAS)) {
  let timer
  on(tela.input, 'input', (e) => {
    clearTimeout(timer)
    const termo = e.target.value.trim()
    timer = setTimeout(() => buscar(termo, tela), 300)
  })
  on(tela.retry, 'click', (e) =>
    ocupado(e.currentTarget, () => buscar($(tela.input).value.trim(), tela)))
}

// `sala_canon` entra: o placeholder promete busca por sala, mas só o rótulo cru
// da planilha era olhado, então procurar "P2-202" (o número que está na porta)
// não achava nada
const bate = (r, alvo) => [r.disciplina, r.professor, r.codigo, r.sala, r.sala_canon, r.turma]
  .some((v) => String(v ?? '').toLowerCase().includes(alvo))

const aspasPostgrest = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

async function buscar(termo, tela) {
  const lista = $(tela.lista)
  $(tela.falha).hidden = true
  if (termo.length < 2) {
    lista.replaceChildren()
    $(tela.vazio).hidden = true
    $(tela.semMapa).hidden = true
    $(tela.dica).hidden = false
    return
  }
  $(tela.dica).hidden = true
  // sem o bundle não existe busca: antes disto a dica sumia ao digitar, o
  // `sb.from` lançava, e sobravam quatro esqueletos pulsando pra sempre
  if (!sb) {
    lista.replaceChildren()
    $(tela.vazio).hidden = true
    $(tela.falha).hidden = false
    return
  }
  ghostLinhas(lista, 4)
  const meu = ++tela.seq
  await pronto            // sem isto a primeira busca da sessão marca tudo "sem aula hoje"
  if (meu !== tela.seq) return

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
  if (meu !== tela.seq) return
  // o `return` seco deixava os quatro esqueletos pulsando pra sempre e o toast
  // sumia em 3,2s: o aluno ficava olhando um fantasma sem explicação nenhuma
  if (error) {
    lista.replaceChildren()
    $(tela.vazio).hidden = true
    $(tela.semMapa).hidden = true
    $(tela.falha).hidden = false
    return
  }
  const semAulaHoje = (data ?? []).filter((r) => !codigosHoje.has(r.codigo))
    .sort((a, b) => String(a.disciplina).localeCompare(String(b.disciplina), 'pt-BR'))

  const cards = [
    ...linhasHoje.map((r) => cardAula(r, tela)),
    ...semAulaHoje.map((r) => cardCatalogo(r, tela)),
  ]
  lista.removeAttribute('aria-busy')
  lista.replaceChildren(...cards)
  $(tela.status).textContent = cards.length
    ? `${cards.length} ${cards.length === 1 ? 'resultado' : 'resultados'}`
    : 'nada encontrado'
  $(tela.vazio).hidden = cards.length > 0
  // sem mapa carregado a busca NÃO afirma nada sobre hoje: dizer "sem aula hoje"
  // pra aula que está acontecendo é pior que dizer "não sei"
  $(tela.semMapa).hidden = mapaCarregado || cards.length === 0
}

// O chip mostra a sala CANÔNICA quando o repertório resolveu, e o rótulo cru da
// planilha desce pra meta. Rótulo cru pode ser gigante
// ("207 (P2) LAB.PROJETOS ELETRICOS/206 (P2)") e, dentro de um chip, engolia a
// linha inteira: a disciplina saía uma letra por linha no celular.
const chipSala = (r) => r.sala_canon || r.sala || '—'

// A meta da linha estourava em duas e três alturas no celular: "hoje · 07:30/09:20
// · 4 ENG/4 E.COMP · SERGIO LUIZ ARAUJO VIEIRA" não cabe em 390px de jeito
// nenhum. Encurtar é melhor que deixar quebrar, e o texto inteiro fica no `title`
// pra quem quiser conferir. O `hoje ·` some porque o cartão já está na lista de
// hoje. Nada disto toca no que a busca CASA: `bate()` continua olhando o campo
// cru da planilha.
function nomeCurto(nome) {
  const partes = String(nome ?? '').trim().split(/\s+/).filter(Boolean)
  if (partes.length < 2) return partes[0] ?? ''
  return `${partes[0][0]}. ${partes[partes.length - 1]}`
}
// "4 ENG/4 E.COMP" é a mesma turma escrita duas vezes, uma por curso
const turmaCurta = (t) => String(t ?? '').split('/')[0].trim()

// a meta cabe numa linha só, com reticências quando não couber, e o texto
// completo vai no title
function metaEnxuta(el, completa) {
  const span = el.querySelector('.meta')
  if (!span) return el
  span.classList.add('meta-1l')
  span.title = completa
  return el
}

// `tela.adicionar` é o que separa consulta de cadastro: na Planilha dinâmica o
// cartão é só informação, e o bloco de pílulas só existe na tela de Adicionar
// disciplinas. O `perfil` continua sendo exigido porque insert sem sessão o
// banco recusa, e um botão que sempre falha é pior que botão nenhum.
function cardAula(r, { adicionar } = {}) {
  const el = li(`
    <span class="disc">${esc(r.disciplina || 'Reserva')}</span>
    <span class="sala">${esc(chipSala(r))}</span>
    <span class="meta">${esc(r.horario)} · ${esc(turmaCurta(r.turma))} · ${esc(nomeCurto(r.professor))}</span>`)
  metaEnxuta(el, `hoje · ${r.horario} · ${r.turma} · ${r.professor}`)
  if (adicionar && perfil && r.codigo) el.append(acoesAdicionar(r))
  return el
}

function cardCatalogo(r, { adicionar } = {}) {
  const situacao = mapaCarregado ? 'sem aula hoje' : 'mapa de hoje indisponível'
  // sem o quadrado cinza com traço: aqui ele não significava nada (a meta já diz
  // "sem aula hoje") e ainda deixava a lista com dois tratamentos de sala lado a
  // lado. No "Hoje" ele fica, porque lá o traço quer dizer "sua aula é agora e eu
  // não sei a sala", que é informação de verdade.
  const el = li(`
    <span class="disc">${esc(r.disciplina)}</span>
    <span class="meta">${situacao} · ${esc(turmaCurta(r.turma))} · ${esc(nomeCurto(r.professor))}</span>`)
  metaEnxuta(el, `${situacao} · ${r.turma} · ${r.professor} · ${r.codigo}`)
  if (adicionar && perfil) el.append(acoesAdicionar(r))
  return el
}

// A pílula É a ação: tocar no dia adiciona a matéria naquele dia, sem segundo
// toque. Antes eram dois passos (escolher o dia, confirmar num botão que dizia
// "Adicionar na QUI"), e com seis pílulas mais o botão cada resultado da lista
// ocupava quatro alturas no celular. O que já está na sua lista aparece marcado
// ANTES de você tentar (o aviso de duplicado só chegava depois da ida ao
// servidor). Tirar dia é só em Minhas aulas, com o × da pílula: dois lugares
// fazendo a mesma coisa é o que esta tela acabou de deixar de ser.
function acoesAdicionar(r) {
  const fila = document.createElement('span')
  fila.className = 'dias dias-escolha'

  const novos = new Set()
  const jaTem = (d) => novos.has(d) || minhas.some((m) => m.dia === d &&
    (r.codigo ? m.codigo === r.codigo : m.disciplina === r.disciplina))

  function pintar() {
    for (const p of fila.children) {
      const d = +p.dataset.dia
      const tem = jaTem(d)
      p.classList.toggle('ja-tem', tem)
      // o ✓ carrega o "já tenho" junto com a borda tracejada: dizer isso só por
      // cor mais fraca reprovava no contraste do tema claro
      p.textContent = tem ? `${DIAS[d]} ✓` : DIAS[d]
      // `aria-disabled` e não `disabled`: o atributo de verdade traz a cor cinza
      // do próprio navegador, que sai de baixo do contraste.py
      p.setAttribute('aria-disabled', String(tem))
      p.setAttribute('aria-label', tem
        ? `${DIAS_LONGO[d]}, já na sua lista`
        : `Adicionar ${r.disciplina} na ${DIAS_LONGO[d]}`)
    }
  }

  for (let d = 1; d <= 6; d++) {
    const p = document.createElement('button')
    p.type = 'button'
    p.className = 'pill-dia pill-escolha'
    p.dataset.dia = d
    p.textContent = DIAS[d]
    p.addEventListener('click', async () => {
      if (jaTem(d)) return
      // marca a pílula na hora: `carregarMinhas` é assíncrono e a fila ficaria
      // sem o ✓ numa matéria que já entrou
      if (await adicionarMateria(r, d, p)) novos.add(d)
      pintar()
    })
    fila.append(p)
  }

  pintar()
  return fila
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

// Os botões da home nascem borrados e inertes (o do meio muda de nome conforme a
// sessão), e destravam quando o app sabe quem é você. Três gatilhos, porque
// deixar a home travada é pior que destravar cedo: sem bundle não haverá sessão
// nenhuma; o perfil resolvido é o caso normal; e o teto de tempo cobre a rede
// que pendura sem avisar, que é o mesmo motivo do `comTeto`.
function destravarMenu() {
  const menu = $('menu-home')
  if (!menu || !menu.hasAttribute('data-carregando')) return
  menu.removeAttribute('data-carregando')
  menu.removeAttribute('inert')
}
setTimeout(destravarMenu, 2500)

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
  // a próxima abertura já nasce com o menu do tamanho certo: sem isto o quarto
  // botão existia por meio segundo e sumia, empurrando a home inteira
  gravarCasca({ username: logado ? perfil.username : null })
  if (cadastrando) {
    mostrar('conta')                     // volta do OAuth cai no passo pendente
    $('username-input').focus({ preventScroll: true })
  }
  // daqui pra frente o rótulo do botão do meio é o definitivo
  destravarMenu()
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
    // sair estando em Ajustes (ou na tela de adicionar disciplina) deixava a
    // pessoa parada numa tela que só existe com conta, sem dizer por quê
    if (TELAS_LOGADO.includes(telaAtual)) mostrar('home')
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

// Quem tem conta abre na HOME, não em "Minhas aulas". O #41 mandava direto pras
// aulas do dia e o caminho ficou pior: a home é onde estão os quatro caminhos do
// app (planilha, faculdade agora, conta) e o aluno logado perdia a entrada de
// tudo que não fosse a grade dele. O botão do menu já diz `Minhas aulas
// (username)` quando há sessão, então a grade continua a um toque.

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
    pintarTesteDePush()
    return
  }
  // permissão negada no sistema é caminho sem saída, e o interruptor aparecia
  // habilitado e desmarcado, como se bastasse tocar: o aluno tocava, nada
  // acontecia (o requestPermission só abre diálogo quando a permissão é
  // `default`) e o toast de "negada" sumia em 3 segundos
  if ('Notification' in window && Notification.permission === 'denied') {
    chk.disabled = true
    chk.checked = false
    rotulo.textContent = 'Avisos bloqueados no sistema'
    dica.textContent = 'A permissão de notificação do IBSALA foi negada neste aparelho. ' +
      'No iPhone: Ajustes → Notificações → IBSALA. No computador: cadeado da barra de ' +
      'endereço → Notificações.'
    pintarTesteDePush()
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
    pintarTesteDePush()
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
  pintarTesteDePush()
}

// ── Aviso de teste ───────────────────────────────────────────────────────────
// O interruptor prova que a inscrição EXISTE. Nunca existiu nada que provasse
// que o aviso CHEGA: `push_subscriptions` está em 0 desde o cutover e ninguém
// nunca confirmou entrega em aparelho real. Aqui o app manda um push de verdade
// e só declara sucesso quando o service worker devolve o recado de que recebeu.
const PUSH_OK_CHAVE = 'ibsala:push-ok'
const ESPERA_TESTE = 15000
// o botão volta antes de o aviso chegar no aparelho, e dava pra disparar cinco
// seguidos: cada toque é um push de verdade saindo pro FCM
const TRAVA_TESTE = 2000
let timerTeste = null
let travadoAte = 0

function ultimoTesteOk() {
  try { return Number(localStorage.getItem(PUSH_OK_CHAVE) ?? 0) } catch { return 0 }
}

function statusTeste(texto) {
  const p = $('push-teste-status')
  if (!p) return
  p.textContent = texto
  p.hidden = !texto
}

function quandoLegivel(ms) {
  const d = new Date(ms)
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const hoje = new Date().toDateString() === d.toDateString()
  return hoje ? `às ${hora}` : `em ${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}, ${hora}`
}

function pintarTesteDePush() {
  const btn = $('btn-push-teste')
  const chk = $('chk-push')
  if (!btn || !chk) return
  // sem inscrição ligada não há o que testar, e o botão habilitado prometeria
  // uma resposta que nunca viria. A trava de 2s entra aqui também porque
  // `atualizarBotaoPush` repinta o botão no meio dela.
  btn.disabled = !chk.checked || Date.now() < travadoAte
  if (timerTeste) return
  const ok = ultimoTesteOk()
  statusTeste(ok ? `Último aviso confirmado neste aparelho ${quandoLegivel(ok)}.` : '')
}

navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.tipo !== 'push-teste-recebido') return
  clearTimeout(timerTeste)
  timerTeste = null
  try { localStorage.setItem(PUSH_OK_CHAVE, String(e.data.em ?? Date.now())) } catch { /* privada */ }
  statusTeste(`Aviso de teste recebido ${quandoLegivel(e.data.em ?? Date.now())}. Está funcionando.`)
})
// SEM ESTA LINHA a mensagem acima nunca chega. O ServiceWorkerContainer segura a
// fila de mensagens do worker até alguém atribuir `onmessage` ou chamar
// `startMessages()`; com `addEventListener` sozinho ela fica parada pra sempre.
// Era isso que deixava o teste preso em "Esperando ele chegar neste aparelho"
// COM o aviso ja na tela do celular, e o #44 subiu com esse buraco.
navigator.serviceWorker?.startMessages?.()

on('btn-push-teste', 'click', async (ev) => {
  const alvo = ev.currentTarget
  await ocupado(alvo, () => enviarTeste())
  // trava anti-spam: o `finally` do ocupado destrava o botão assim que o
  // servidor responde, o que é bem antes de o aviso chegar no aparelho
  travadoAte = Date.now() + TRAVA_TESTE
  alvo.disabled = true
  setTimeout(pintarTesteDePush, TRAVA_TESTE)
})

async function enviarTeste() {
  clearTimeout(timerTeste)
  statusTeste('Enviado. Esperando ele chegar neste aparelho…')
  const { data, error } = await chamar(sb.functions.invoke('push-teste', { method: 'POST' }))
  if (error) {
    timerTeste = null
    statusTeste(`Não deu pra enviar: ${error.msg}`)
    return
  }
  if (!data?.enviados) {
    timerTeste = null
    statusTeste(data?.motivo === 'sem inscricao'
      ? 'Este aparelho não está inscrito. Liga o interruptor acima e tenta de novo.'
      : 'O servidor não conseguiu entregar o aviso. Desliga e liga o interruptor acima.')
    // inscrição morta some do banco no envio: o interruptor tem que parar de
    // dizer que está tudo certo
    if (data?.limpas) atualizarBotaoPush()
    return
  }
  // o `finally` do ocupado destrava o botão; o timer é quem decide o texto
  timerTeste = setTimeout(() => {
    timerTeste = null
    statusTeste('Enviamos, mas ele não chegou aqui em 15 segundos. Confere se a notificação ' +
      'do IBSALA está liberada nos ajustes do aparelho e, no iPhone, se o app foi aberto ' +
      'pelo ícone da Tela de Início.')
  }, ESPERA_TESTE)
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
    // dos 17 cadastrados pararam exatamente aqui. Vai pra tela de adicionar, que
    // é a única das duas buscas que monta a grade.
    if (!minhas.length) mostrar('materias')
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
    <span class="meta">${esc(turmaCurta(g.turma))} · ${esc(nomeCurto(g.professor))}</span>`)
  metaEnxuta(el, `${g.turma} · ${g.professor ?? ''} · ${g.codigo}`)

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

  // Sem botão "Remover": `materias` guarda uma linha por (aluno, código, dia),
  // então tirar o último × apaga a última linha e o bloco some sozinho da lista.
  // O botão fazia isso de uma vez, com confirmação em dois toques, e era um
  // segundo controle pra mesma coisa dentro de um bloco de três alturas.
  el.append(dias)
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
      return false
    }
    toast(`Adicionada na ${DIAS[dia]}.`)
    carregarMinhas()
    return true
  })
}

// ── Init ─────────────────────────────────────────────────────────────────────
aplicarIntencao('entrar')
const telaInicial = location.hash.replace('#', '')
history.replaceState({ tela: TELAS.includes(telaInicial) ? telaInicial : 'home' }, '', location.hash || '#')
if (TELAS.includes(telaInicial) && telaInicial !== 'home') mostrar(telaInicial, { push: false })

procurarAtualizacao()
pintarRelogio()          // cabeçalho vivo desde o primeiro quadro, sem esperar rede

// A casca da última sessão entra ANTES de qualquer rede: é ela que dá à tela o
// tamanho final no primeiro quadro. Cada peça aqui é uma que crescia, aparecia
// ou sumia quando o dado chegava.
;(() => {
  const casca = lerCasca()
  if (casca.username) {
    // menu já nasce com três botões, do jeito que vai ficar
    $('btn-menu-entrar').textContent = `Minhas aulas (${casca.username})`
    $('btn-menu-criar').hidden = true
  }
  if (typeof casca.alunos === 'number') {
    $('pill-alunos').textContent = `${casca.alunos} ${casca.alunos === 1 ? 'aluno' : 'alunos'}`
    $('pill-alunos').hidden = false
    vulto('pill-alunos', true)
  }
  // o hero de "Faculdade agora" fica FORA da casca de propósito: ali o número é
  // a resposta inteira da tela, e um valor velho, mesmo borrado, é o tipo de
  // afirmação sem base que o app passou a auditoria de 12/08 inteira tirando.
  // A pill do cabeçalho entra porque o que ela empurra é o layout, não a decisão.
  if (typeof casca.livres === 'number') {
    $('pill-livres').textContent = `${casca.livres} livres`
    vulto('pill-livres', true)
  }
  if (casca.frescor) {
    $('pill-frescor').textContent = casca.frescor
    $('pill-frescor').hidden = false
    vulto('pill-frescor', true)
  }
})()

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
  // sem bundle não vai existir sessão nenhuma pra esperar
  destravarMenu()
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
