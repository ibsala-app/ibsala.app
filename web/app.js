import { SUPABASE_URL, SUPABASE_KEY, VAPID_PUBLIC_KEY } from './config.js'

// supabase-js chega via bundle UMD (script defer no index) — 1 request, cache longo
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)

// ── Slots (portado do v1) ────────────────────────────────────────────────────
const SLOTS = {
  manha1: { label: '1º Manhã', ini: 6 * 60,       fim: 9 * 60 + 29 },
  manha2: { label: '2º Manhã', ini: 9 * 60 + 30,  fim: 12 * 60 + 59 },
  tarde1: { label: '1º Tarde', ini: 13 * 60,      fim: 15 * 60 + 29 },
  tarde2: { label: '2º Tarde', ini: 15 * 60 + 30, fim: 17 * 60 + 59 },
  noite1: { label: '1º Noite', ini: 18 * 60,      fim: 18 * 60 + 59 },
  noite2: { label: '2º Noite', ini: 19 * 60,      fim: 23 * 60 + 59 },
}
const DIAS = ['', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB']

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
function horarioParaSlot(h) {
  const m = parseHora(String(h ?? '').split('/')[0])
  if (m == null) return null
  for (const [k, s] of Object.entries(SLOTS)) if (m >= s.ini && m <= s.fim) return k
  return null
}
function parseHora(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? '').trim())
  return m ? +m[1] * 60 + +m[2] : null
}
function intervaloContem(horario, min) {
  const [a, b] = String(horario ?? '').split('/')
  const ia = parseHora(a), ib = parseHora(b)
  return ia != null && ib != null && min >= ia && min <= ib
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

function mostrar(tela) {
  document.querySelectorAll('.tela').forEach((x) => x.classList.remove('ativa'))
  $(`tela-${tela}`).classList.add('ativa')
  window.scrollTo(0, 0)
}

document.querySelectorAll('[data-vai]').forEach((b) => {
  b.addEventListener('click', () => mostrar(b.dataset.vai))
})

// ── Agora ────────────────────────────────────────────────────────────────────
let mapaHoje = []
let salas = []

async function carregarAgora() {
  const [mapa, inv] = await Promise.all([
    sb.from('mapa_dia').select('categoria,turma,codigo,disciplina,horario,professor,sala')
      .eq('data', hojeISO()),
    sb.from('salas').select('sala,predio').order('sala'),
  ])
  if (mapa.error || inv.error) { toast('Sem conexão com o servidor.'); return }
  mapaHoje = mapa.data
  salas = inv.data

  const slot = slotAtual()
  const d = agoraBRT()
  const DIAS_LONGO = ['DOMINGO', 'SEGUNDA', 'TERÇA', 'QUARTA', 'QUINTA', 'SEXTA', 'SÁBADO']
  $('pill-data').textContent =
    `${DIAS_LONGO[d.getDay()]} · ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
  $('pill-slot').textContent = slot ? SLOTS[slot].label : 'Fora de horário'

  const min = minutosAgora()
  const rolando = []
  const vistos = new Set()
  for (const r of mapaHoje) {
    if (!intervaloContem(r.horario, min)) continue
    const k = [r.horario, r.sala, r.disciplina, r.turma].join('|')
    if (vistos.has(k)) continue
    vistos.add(k)
    rolando.push(r)
  }

  const ocupadas = new Set(
    mapaHoje.filter((r) => horarioParaSlot(r.horario) === slot && r.sala)
      .map((r) => r.sala))
  const livres = slot ? salas.filter((s) => !ocupadas.has(s.sala)) : []

  $('livres-num').textContent = slot ? livres.length : '–'
  $('livres-rotulo').textContent = slot
    ? `salas livres no ${SLOTS[slot].label.toLowerCase()}`
    : 'fora do horário de aulas'
  $('pill-livres').textContent = slot ? `${livres.length} salas livres` : `${salas.length} salas`
  const grade = $('livres-grade')
  grade.replaceChildren(...livres.slice(0, 40).map((s) => {
    const c = document.createElement('span')
    c.className = 'sala-chip'
    c.textContent = s.sala
    return c
  }))

  const board = $('board-agora')
  board.replaceChildren(...rolando.map((r) => li(`
    <span class="disc">${esc(r.disciplina)}</span>
    <span class="sala">${esc(r.sala || '?')}</span>
    <span class="meta">${esc(r.turma)} · ${esc(r.professor)} · ${esc(r.horario)}</span>`)))
  $('agora-vazio').hidden = rolando.length > 0
}

// ── Busca ────────────────────────────────────────────────────────────────────
let buscaTimer
$('busca-input').addEventListener('input', (e) => {
  clearTimeout(buscaTimer)
  buscaTimer = setTimeout(() => buscar(e.target.value.trim()), 300)
})

async function buscar(termo) {
  const lista = $('busca-lista')
  if (termo.length < 2) { lista.replaceChildren(); $('busca-vazio').hidden = true; return }
  const t = `%${termo}%`
  const { data, error } = await sb.from('disciplinas_historico')
    .select('codigo,turma,disciplina,professor')
    .or(`disciplina.ilike.${t},professor.ilike.${t},codigo.ilike.${t}`)
    .limit(20)
  if (error) { toast('Busca falhou. Tenta de novo.'); return }
  lista.replaceChildren(...data.map((r) => {
    const el = li(`
      <span class="disc">${esc(r.disciplina)}</span>
      <span class="sala">${esc((r.codigo || '').split('-')[0])}</span>
      <span class="meta">${esc(r.turma)} · ${esc(r.professor)} · ${esc(r.codigo)}</span>`)
    if (perfil) {
      const acoes = document.createElement('span')
      acoes.className = 'acoes'
      const sel = document.createElement('select')
      sel.className = 'mini'
      sel.innerHTML = DIAS.map((d, i) => i ? `<option value="${i}">${d}</option>` : '').join('')
      const btn = document.createElement('button')
      btn.className = 'mini'
      btn.textContent = 'Adicionar'
      btn.addEventListener('click', () => adicionarMateria(r, +sel.value))
      acoes.append(sel, btn)
      el.append(acoes)
    }
    return el
  }))
  $('busca-vazio').hidden = data.length > 0
}

// ── Conta ────────────────────────────────────────────────────────────────────
let sessao = null
let perfil = null

function mostrarConta() {
  $('conta-deslogado').hidden = !!sessao
  $('conta-cadastro').hidden = !(sessao && !perfil)
  $('conta-logado').hidden = !(sessao && perfil)
  $('btn-menu-conta').textContent = perfil ? `Minhas aulas (${perfil.username})` : 'Entrar'
  // volta do OAuth: cai direto no passo pendente da conta
  if (sessao && !perfil) mostrar('conta')
}

async function carregarPerfil() {
  if (!sessao) { perfil = null; mostrarConta(); return }
  const { data } = await sb.from('alunos').select('*').eq('id', sessao.user.id).maybeSingle()
  perfil = data
  mostrarConta()
  if (perfil) {
    sb.rpc('touch_ultimo_acesso').then(() => {})
    carregarMinhas()
    atualizarBotaoPush()
    $('bloco-admin').hidden = perfil.role !== 'admin'
    if (perfil.role === 'admin') carregarAdmin()
  }
}

// ── Push (avisos de sala) ────────────────────────────────────────────────────
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
  if (!('PushManager' in window)) {
    btn.disabled = true
    btn.textContent = 'Avisos não suportados neste navegador'
    return
  }
  const sub = await subAtual()
  btn.textContent = sub ? 'Desativar avisos neste aparelho' : 'Ativar avisos neste aparelho'
}

$('btn-push').addEventListener('click', async () => {
  const sub = await subAtual()
  if (sub) {
    await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
    await sub.unsubscribe()
    toast('Avisos desativados.')
  } else {
    const perm = await Notification.requestPermission()
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
  }
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
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `ibsala-dados-${hojeISO()}.json`
  a.click()
  URL.revokeObjectURL(a.href)
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
  const [cfg, recs, todos] = await Promise.all([
    sb.from('config').select('value').eq('key', 'travado').single(),
    sb.from('reclamacoes').select('id,descricao,criado,alunos(username)')
      .is('resolvido_em', null).order('criado'),
    sb.from('alunos').select('id,username,email,role,bloqueado').order('criado'),
  ])

  const travado = cfg.data?.value === true
  $('btn-trava').textContent = travado ? 'Destravar o site' : 'Travar o site'
  $('btn-trava').onclick = async () => {
    await sb.from('config').update({ value: !travado }).eq('key', 'travado')
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
  const { data, error } = await sb.from('materias')
    .select('id,dia,turma,disciplina,professor,codigo')
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

  const hoje = agoraBRT().getDay()
  const deHoje = data.filter((m) => m.dia === hoje)
  const board = $('board-hoje')
  board.replaceChildren(...deHoje.map((m) => {
    const aula = mapaHoje.find((r) => r.codigo && r.codigo === m.codigo)
    return li(`
      <span class="disc">${esc(m.disciplina)}</span>
      <span class="sala">${esc(aula?.sala || '—')}</span>
      <span class="meta">${esc(aula?.horario || 'sem sala no mapa ainda')} · ${esc(m.turma)}</span>`)
  }))
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
sb.auth.onAuthStateChange((_ev, s) => {
  sessao = s
  carregarPerfil()
})

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js')

carregarAgora()
setInterval(carregarAgora, 5 * 60 * 1000)
