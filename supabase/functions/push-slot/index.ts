// push-slot: dispara web push "sua sala é X" pros alunos com aula no slot.
// Chamada pelo pg_cron (~50 min antes de cada slot) com {"slot":"manha1"}.
// Deploy: supabase functions deploy push-slot --no-verify-jwt
// Secrets da function: CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
//                      SUPABASE_URL, SERVICE_KEY

import webpush from 'npm:web-push@3.6.7'

const SLOTS: Record<string, [number, number]> = {
  manha1: [6 * 60, 9 * 60 + 29],
  manha2: [9 * 60 + 30, 12 * 60 + 59],
  tarde1: [13 * 60, 15 * 60 + 29],
  tarde2: [15 * 60 + 30, 17 * 60 + 59],
  noite1: [18 * 60, 18 * 60 + 59],
  noite2: [19 * 60, 23 * 60 + 59],
}

const URL_BASE = Deno.env.get('SUPABASE_URL')!
const KEY = Deno.env.get('SERVICE_KEY')!

webpush.setVapidDetails(
  'mailto:ibsala.app@gmail.com',
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
)

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  return r.status === 204 ? null : r.json()
}

function hojeBRT() {
  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
  return {
    iso: agora.toLocaleDateString('sv-SE'),
    diaSemana: agora.getDay(), // 1=SEG … 6=SAB (materias.dia)
  }
}

function slotDoHorario(h: string): string | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(h ?? '').split('/')[0]?.trim() ?? '')
  if (!m) return null
  const min = +m[1] * 60 + +m[2]
  for (const [k, [a, b]] of Object.entries(SLOTS)) if (min >= a && min <= b) return k
  return null
}

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) {
    return new Response('nope', { status: 401 })
  }
  const { slot } = await req.json().catch(() => ({}))
  if (!SLOTS[slot]) return new Response('slot inválido', { status: 400 })

  const { iso, diaSemana } = hojeBRT()

  const mapa: any[] = await rest(
    `mapa_dia?data=eq.${iso}&select=codigo,disciplina,horario,professor,sala`)
  const doSlot = mapa.filter((r) => r.codigo && r.sala && slotDoHorario(r.horario) === slot)
  if (!doSlot.length) return Response.json({ enviados: 0, motivo: 'mapa vazio no slot' })
  const porCodigo = new Map(doSlot.map((r) => [r.codigo, r]))

  const materias: any[] = await rest(
    `materias?dia=eq.${diaSemana}&select=aluno_id,codigo,disciplina,` +
    `alunos!inner(bloqueado)&alunos.bloqueado=eq.false`)

  const porAluno = new Map<string, any[]>()
  for (const m of materias) {
    const aula = porCodigo.get(m.codigo)
    if (!aula) continue
    if (!porAluno.has(m.aluno_id)) porAluno.set(m.aluno_id, [])
    porAluno.get(m.aluno_id)!.push(aula)
  }
  if (!porAluno.size) return Response.json({ enviados: 0, motivo: 'ninguém com aula' })

  const subs: any[] = await rest(
    `push_subscriptions?aluno_id=in.(${[...porAluno.keys()].join(',')})` +
    `&select=endpoint,p256dh,auth,aluno_id`)

  let enviados = 0
  await Promise.all(subs.map(async (s) => {
    const aulas = porAluno.get(s.aluno_id)!
    const salas = [...new Set(aulas.map((a) => a.sala))]
    const titulo = salas.length === 1 ? `Sala ${salas[0]}` : `Salas ${salas.join(', ')}`
    const corpo = aulas.map((a) =>
      `${a.disciplina} · ${(a.professor || '').split(' ')[0]} · ${a.horario}`).join('\n')
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: titulo, body: corpo, tag: `ibsala-${slot}` }),
      )
      enviados++
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`,
          { method: 'DELETE' })
      }
    }
  }))

  return Response.json({ enviados, alunos: porAluno.size, subs: subs.length })
})
