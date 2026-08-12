import { SUPABASE_URL, SUPABASE_KEY, VAPID_PUBLIC_KEY } from './config.js'

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
navigator.serviceWorker?.addEventListener('controllerchange', () => {
  // primeira instalação também dispara controllerchange, e aí recarregar é ruído
  if (!tinhaControlador || recarregandoPraAtualizar) return
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
const TELAS = ['home', 'agora', 'buscar', 'conta']

function agoraBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
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
function horarioParaSlot(h) {
  const f = faixaHoraria(h)
  if (!f) return null
  for (const [k, s] of Object.entries(SLOTS)) if (f[0] >= s.ini && f[0] <= s.fim) return k
  return null
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
function hhmm(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}
function proximoSlot(min) {
  for (const [k, s] of Object.entries(SLOTS)) if (s.ini > min) return { k, ...s }
  return null
}

// ── UI helpers ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id)
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
  el.replaceChildren(...Array.from({ length: n }, () => {
    const l = document.createElement('li')
    l.className = 'ghost-li'
    l.innerHTML = '<span class="ghost g-disc"></span><span class="ghost g-sala"></span>' +
      '<span class="ghost g-meta"></span>'
    return l
  }))
}
function ghostChips(el, n = 12) {
  el.replaceChildren(...Array.from({ length: n }, () => {
    const c = document.createElement('span')
    c.className = 'ghost g-chip'
    return c
  }))
}

// ── Navegação (com history, pra o gesto de voltar não fechar a PWA) ──────────
let telaAtual = 'home'

function mostrar(tela, { push = true } = {}) {
  if (!TELAS.includes(tela)) tela = 'home'
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
    mostrar(b.dataset.vai)
  })
})

window.addEventListener('popstate', (e) => mostrar(e.state?.tela ?? 'home', { push: false }))

// ── Estado compartilhado ─────────────────────────────────────────────────────
let mapaHoje = []
let salas = []
let cfg = {}
let totalAlunos = null
let pronto = null

// ── Faculdade agora ──────────────────────────────────────────────────────────
async function carregarAgora({ ghost = false } = {}) {
  if (!sb) return              // sem bundle não há o que buscar; o aviso já está na tela
  if (ghost) {
    $('livres-num').classList.add('ghost-num')
    ghostChips($('livres-grade'))
    ghostLinhas($('board-agora'))
  }
  const [mapa, inv, conf, quantos] = await Promise.all([
    sb.from('mapa_dia').select('categoria,turma,codigo,disciplina,horario,professor,sala,sala_canon')
      .eq('data', hojeISO()),
    sb.from('salas').select('sala,predio').eq('ativa', true).order('sala'),
    sb.from('config').select('key,value'),
    sb.rpc('total_alunos'),
  ])
  if (mapa.error || inv.error) {
    $('agora-falha').hidden = false
    $('livres-num').classList.remove('ghost-num')
    $('livres-grade').replaceChildren()
    $('board-agora').replaceChildren()
    toast('Sem conexão com o servidor.')
    return
  }
  $('agora-falha').hidden = true
  mapaHoje = mapa.data
  salas = inv.data
  if (!conf.error) cfg = Object.fromEntries((conf.data ?? []).map((r) => [r.key, r.value]))
  if (!quantos.error && typeof quantos.data === 'number') totalAlunos = quantos.data
  aplicarTrava()
  pintarAgora()
}

function pintarAgora() {
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

  const rolando = []
  const vistos = new Set()
  for (const r of mapaHoje) {
    if (!intervaloContem(r.horario, min)) continue
    const k = [r.horario, r.sala, r.disciplina, r.turma, r.professor].join('|')
    if (vistos.has(k)) continue
    vistos.add(k)
    rolando.push(r)
  }
  $('board-agora').replaceChildren(...rolando.map((r) => li(`
    <span class="disc">${esc(r.disciplina || 'Reserva')}</span>
    <span class="sala">${esc(chipSala(r))}</span>
    <span class="meta">${esc(r.turma)} · ${esc(r.professor)} · ${esc(r.horario)}${esc(rotuloCru(r))}</span>`)))
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
  $('pill-frescor').hidden = !(quando && !isNaN(quando))
  if (quando && !isNaN(quando)) {
    $('pill-frescor').textContent = 'mapa de ' + quando.toLocaleTimeString('pt-BR',
      { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
  }
}

$('btn-retry').addEventListener('click', () => { pronto = carregarAgora({ ghost: true }) })

// ── Trava do site (o botão do admin agora vale de verdade) ───────────────────
function aplicarTrava() {
  const bloqueado = cfg.travado === true && perfil?.role !== 'admin'
  $('bloqueio').hidden = !bloqueado
  document.body.classList.toggle('bloqueado', bloqueado)
  if (bloqueado) window.scrollTo(0, 0)
}

// ── Planilha dinâmica ────────────────────────────────────────────────────────
let buscaTimer
$('busca-input').addEventListener('input', (e) => {
  clearTimeout(buscaTimer)
  buscaTimer = setTimeout(() => buscar(e.target.value.trim()), 300)
})

const bate = (r, alvo) => [r.disciplina, r.professor, r.codigo, r.sala, r.turma]
  .some((v) => String(v ?? '').toLowerCase().includes(alvo))

async function buscar(termo) {
  const lista = $('busca-lista')
  if (termo.length < 2) {
    lista.replaceChildren()
    $('busca-vazio').hidden = true
    $('busca-dica').hidden = false
    return
  }
  $('busca-dica').hidden = true
  ghostLinhas(lista, 4)
  await pronto            // sem isto a primeira busca da sessão marca tudo "sem aula hoje"

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
  const codigosHoje = new Set(deHoje.map((r) => r.codigo).filter(Boolean))

  // 2) catálogo cobre quem não tem aula hoje (289 disciplinas contra 99 no mapa)
  const t = `%${termo}%`
  const { data, error } = await sb.from('disciplinas_historico')
    .select('codigo,turma,disciplina,professor')
    .or(`disciplina.ilike.${t},professor.ilike.${t},codigo.ilike.${t}`)
    .limit(30)
  if (error) { toast('Busca falhou. Tenta de novo.'); return }
  const semAulaHoje = (data ?? []).filter((r) => !codigosHoje.has(r.codigo))

  const cards = [
    ...linhasHoje.map((r) => cardAula(r)),
    ...semAulaHoje.map((r) => cardCatalogo(r)),
  ]
  lista.replaceChildren(...cards)
  $('busca-vazio').hidden = cards.length > 0
}

// O chip mostra a sala CANÔNICA quando o repertório resolveu, e o rótulo cru da
// planilha desce pra meta. Rótulo cru pode ser gigante
// ("207 (P2) LAB.PROJETOS ELETRICOS/206 (P2)") e, dentro de um chip, engolia a
// linha inteira: a disciplina saía uma letra por linha no celular.
const chipSala = (r) => r.sala_canon || r.sala || '—'
const rotuloCru = (r) => (r.sala && r.sala_canon && r.sala !== r.sala_canon ? ` · ${r.sala}` : '')

function cardAula(r) {
  const el = li(`
    <span class="disc">${esc(r.disciplina || 'Reserva')}</span>
    <span class="sala">${esc(chipSala(r))}</span>
    <span class="meta">hoje · ${esc(r.horario)} · ${esc(r.turma)} · ${esc(r.professor)}${esc(rotuloCru(r))}</span>`)
  if (perfil && r.codigo) el.append(acoesAdicionar(r, { dia: agoraBRT().getDay() }))
  return el
}

function cardCatalogo(r) {
  const el = li(`
    <span class="disc">${esc(r.disciplina)}</span>
    <span class="sala sala-vazia">—</span>
    <span class="meta">sem aula hoje · ${esc(r.turma)} · ${esc(r.professor)} · ${esc(r.codigo)}</span>`)
  if (perfil) el.append(acoesAdicionar(r))
  return el
}

function acoesAdicionar(r, { dia } = {}) {
  const acoes = document.createElement('span')
  acoes.className = 'acoes'
  const sel = document.createElement('select')
  sel.className = 'mini'
  sel.setAttribute('aria-label', 'Dia da semana')
  sel.innerHTML = DIAS.map((d, i) => (i ? `<option value="${i}">${d}</option>` : '')).join('')
  // aula que acontece HOJE já vem com hoje escolhido: o padrão cego em SEG
  // fazia o aluno cadastrar a matéria no dia errado e nunca receber o aviso
  if (dia) sel.value = String(dia)
  const btn = document.createElement('button')
  btn.className = 'mini'
  btn.textContent = 'Adicionar'
  btn.addEventListener('click', () => adicionarMateria(r, +sel.value))
  acoes.append(sel, btn)
  return acoes
}

// ── Conta ────────────────────────────────────────────────────────────────────
let sessao = null
let perfil = null
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

function mostrarConta() {
  $('cta-conta').hidden = !!perfil       // logado não precisa ver "Criar conta"
  $('materias-cta').hidden = !perfil
  $('conta-deslogado').hidden = !!sessao
  $('conta-cadastro').hidden = !(sessao && !perfil)
  $('conta-logado').hidden = !(sessao && perfil)
  // logado, os dois botões de conta colapsam num só
  $('btn-menu-entrar').textContent = perfil ? `Minhas aulas (${perfil.username})` : 'Entrar'
  $('btn-menu-criar').hidden = !!perfil
  if (sessao && !perfil) mostrar('conta')   // volta do OAuth cai no passo pendente
}

async function carregarPerfil() {
  if (!sessao) { perfil = null; mostrarConta(); aplicarTrava(); return }
  const { data } = await sb.from('alunos').select('*').eq('id', sessao.user.id).maybeSingle()
  perfil = data
  mostrarConta()
  aplicarTrava()
  if (perfil) {
    sb.rpc('touch_ultimo_acesso').then(() => {})
    carregarMinhas()
    atualizarBotaoPush()
    $('bloco-admin').hidden = perfil.role !== 'admin'
    if (perfil.role === 'admin') carregarAdmin()
  }
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

async function atualizarBotaoPush() {
  const btn = $('btn-push')
  const dica = $('push-dica')
  if (!('PushManager' in window)) {
    btn.disabled = true
    btn.textContent = 'Avisos não suportados neste navegador'
    return
  }
  // no iPhone o subscribe só funciona com o app na Tela de Início, e sem dizer
  // isso o aluno toca, falha e não entende
  if (ehIOS && !naTelaDeInicio()) {
    btn.disabled = true
    btn.textContent = 'Avisos exigem o app na Tela de Início'
    dica.textContent = 'No iPhone: botão Compartilhar do Safari → "Adicionar à Tela de Início". ' +
      'Abra o IBSALA por esse ícone e o botão de avisos destrava.'
    return
  }
  btn.disabled = false
  const sub = await subAtual()
  btn.textContent = sub ? 'Desativar avisos neste aparelho' : 'Ativar avisos neste aparelho'
}

$('btn-push').addEventListener('click', async () => {
  // requestPermission ANTES de qualquer await: o Safari só aceita o pedido
  // dentro da tarefa do gesto, e esperar o serviceWorker.ready quebrava isso
  const pedido = Notification.permission === 'default'
    ? Notification.requestPermission()
    : Promise.resolve(Notification.permission)

  const sub = await subAtual()
  if (sub) {
    await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
    await sub.unsubscribe()
    toast('Avisos desativados.')
    atualizarBotaoPush()
    return
  }
  const perm = await pedido
  if (perm !== 'granted') { toast('Permissão de notificação negada.'); return }
  const reg = await navigator.serviceWorker.ready
  const nova = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64ParaUint8(VAPID_PUBLIC_KEY),
  })
  const j = nova.toJSON()
  const { error } = await sb.from('push_subscriptions').insert({
    aluno_id: sessao.user.id, endpoint: j.endpoint,
    p256dh: j.keys.p256dh, auth: j.keys.auth,
  })
  if (error) { toast('Não deu pra registrar o aviso.'); await nova.unsubscribe(); return }
  toast('Avisos ativados neste aparelho.')
  atualizarBotaoPush()
})

// ── Reclamações / dados (LGPD) ───────────────────────────────────────────────
$('form-reclamacao').addEventListener('submit', async (e) => {
  e.preventDefault()
  const desc = $('reclamacao-input').value.trim()
  if (!desc) return
  const { error } = await sb.from('reclamacoes').insert({
    aluno_id: sessao.user.id, descricao: desc,
  })
  toast(error ? 'Não deu pra enviar. Tenta de novo.' : 'Reclamação enviada. Valeu!')
  if (!error) $('reclamacao-input').value = ''
})

$('btn-export').addEventListener('click', async () => {
  const { data, error } = await sb.rpc('exportar_meus_dados')
  if (error) { toast('Export falhou. Tenta de novo.'); return }
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
})

let excluirArmado = false
$('btn-excluir').addEventListener('click', async () => {
  if (!excluirArmado) {
    excluirArmado = true
    $('btn-excluir').textContent = 'Tem certeza? Toque de novo pra apagar tudo'
    setTimeout(() => {
      excluirArmado = false
      $('btn-excluir').textContent = 'Excluir minha conta'
    }, 6000)
    return
  }
  const { error } = await sb.functions.invoke('apagar-conta')
  if (error) { toast('Exclusão falhou. Tenta de novo.'); return }
  await sb.auth.signOut()
  mostrar('home')
  toast('Conta e dados excluídos.')
})

// ── Admin ────────────────────────────────────────────────────────────────────
async function carregarAdmin() {
  const [conf, recs, todos] = await Promise.all([
    sb.from('config').select('value').eq('key', 'travado').single(),
    sb.from('reclamacoes').select('id,descricao,criado,alunos(username)')
      .is('resolvido_em', null).order('criado'),
    sb.from('alunos').select('id,username,email,role,bloqueado').order('criado'),
  ])

  const travado = conf.data?.value === true
  $('btn-trava').textContent = travado ? 'Destravar o site' : 'Travar o site'
  $('btn-trava').onclick = async () => {
    await sb.from('config').update({ value: !travado }).eq('key', 'travado')
    cfg.travado = !travado
    aplicarTrava()
    carregarAdmin()
  }

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
    btn.addEventListener('click', async () => {
      await sb.from('reclamacoes').update({ resolvido_em: new Date().toISOString() }).eq('id', r.id)
      carregarAdmin()
    })
    acoes.append(btn)
    el.append(acoes)
    return el
  }))
  $('admin-reclamacoes-vazio').hidden = (recs.data ?? []).length > 0

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
      btn.addEventListener('click', async () => {
        await sb.from('alunos').update({ bloqueado: !a.bloqueado }).eq('id', a.id)
        carregarAdmin()
      })
      acoes.append(btn)
      el.append(acoes)
    }
    return el
  }))
}

$('btn-login').addEventListener('click', async () => {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname },
  })
  if (error) toast('Login Google ainda não configurado neste ambiente.')
})

$('btn-sair').addEventListener('click', async () => {
  await sb.auth.signOut()
  toast('Você saiu.')
})

$('form-username').addEventListener('submit', async (e) => {
  e.preventDefault()
  const u = $('username-input').value.trim()
  const { data: livre } = await sb.rpc('username_disponivel', { candidato: u })
  if (!livre) { toast('Esse username já existe. Tenta outro.'); return }
  const { error } = await sb.from('alunos').insert({
    id: sessao.user.id, username: u, email: sessao.user.email,
  })
  if (error) { toast('Não deu pra criar a conta. Tenta de novo.'); return }
  toast(`Bem-vindo/a, ${u}!`)
  carregarPerfil()
})

async function carregarMinhas() {
  ghostLinhas($('lista-materias'), 3)
  ghostLinhas($('board-hoje'), 2)
  // filtro explicito por aluno: a policy de materias é
  // `aluno_id = auth.uid() OR is_admin()`, então admin sem WHERE enxerga a
  // matéria de TODO MUNDO e "Minhas matérias" listava as 79 dos 18 alunos
  const { data, error } = await sb.from('materias')
    .select('id,dia,turma,disciplina,professor,codigo')
    .eq('aluno_id', sessao.user.id)
    .order('dia').order('disciplina')
  if (error) return
  const lista = $('lista-materias')
  lista.replaceChildren(...data.map((m) => {
    const el = li(`
      <span class="disc">${esc(m.disciplina)}</span>
      <span class="sala">${DIAS[m.dia] ?? '?'}</span>
      <span class="meta">${esc(m.turma)} · ${esc(m.professor ?? '')} · ${esc(m.codigo)}</span>`)
    const acoes = document.createElement('span')
    acoes.className = 'acoes'
    const btn = document.createElement('button')
    btn.className = 'mini'
    btn.textContent = 'Remover'
    btn.addEventListener('click', async () => {
      await sb.from('materias').delete().eq('id', m.id)
      carregarMinhas()
    })
    acoes.append(btn)
    el.append(acoes)
    return el
  }))
  $('materias-vazio').hidden = data.length > 0

  const hoje = agoraBRT().getDay()
  const deHoje = data.filter((m) => m.dia === hoje)
  const board = $('board-hoje')

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
      <span class="meta">${esc(aula.horario)} · ${esc(m.turma)}${esc(rotuloCru(aula))}</span>`)
    : li(`
      <span class="disc">${esc(m.disciplina)}</span>
      <span class="sala sala-vazia">—</span>
      <span class="meta">sem sala no mapa de hoje · ${esc(m.turma)}</span>`))))
  $('hoje-vazio').hidden = deHoje.length > 0
}

async function adicionarMateria(r, dia) {
  const { error } = await sb.from('materias').insert({
    aluno_id: sessao.user.id, dia,
    turma: r.turma ?? '', disciplina: r.disciplina, professor: r.professor, codigo: r.codigo,
  })
  toast(error ? 'Você já tem essa matéria nesse dia.' : `Adicionada na ${DIAS[dia]}.`)
  if (!error) carregarMinhas()
}

// ── Init ─────────────────────────────────────────────────────────────────────
aplicarIntencao('entrar')
const telaInicial = location.hash.replace('#', '')
history.replaceState({ tela: TELAS.includes(telaInicial) ? telaInicial : 'home' }, '', location.hash || '#')
if (TELAS.includes(telaInicial) && telaInicial !== 'home') mostrar(telaInicial, { push: false })

procurarAtualizacao()

if (!sb) {
  // bundle do supabase-js não chegou: em vez de a tela ficar muda com "–" e o
  // aluno achar que o app está quebrado, diz o que houve e oferece recarregar
  $('livres-num').classList.remove('ghost-num')
  $('agora-falha').hidden = false
  $('agora-falha').firstChild.textContent =
    'Não deu pra carregar a biblioteca do app. Se você está numa rede que filtra ' +
    'endereços, pode ser isso. '
  $('busca-dica').textContent = 'Busca fora do ar até a página carregar por completo.'
  $('btn-retry').onclick = () => location.reload()
} else {
  sb.auth.onAuthStateChange((_ev, s) => {
    sessao = s
    carregarPerfil()
  })

  pronto = carregarAgora({ ghost: true })
  setInterval(() => carregarAgora(), 5 * 60 * 1000)
  setInterval(pintarAgora, 60 * 1000)        // relógio e contagem andam sem input
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return
    carregarAgora()          // PWA retomada não mostra número da véspera
    procurarAtualizacao()    // nem versão da véspera
  })
  window.addEventListener('online', () => { carregarAgora(); procurarAtualizacao() })
}
