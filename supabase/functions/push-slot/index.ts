// push-slot: dispara web push "sua sala é X" pros alunos com aula no slot.
// Chamada pelo pg_cron (~50 min antes de cada slot) com {"slot":"manha1"}.
// Deploy: supabase functions deploy push-slot --no-verify-jwt
// Secrets da function: CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
//                      SUPABASE_URL, SERVICE_KEY

import { segredoConfere } from '../_shared/cron.ts'
import { hojeBRT, SLOTS, slotDoInicio } from '../_shared/slots.ts'
import { enviar } from '../_shared/webpush.ts'

const URL_BASE = Deno.env.get('SUPABASE_URL')!
const KEY = Deno.env.get('SERVICE_KEY')!

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

Deno.serve(async (req) => {
  if (!await segredoConfere(req)) return new Response('nope', { status: 401 })
  const { slot } = await req.json().catch(() => ({}))
  if (!SLOTS[slot]) return new Response('slot inválido', { status: 400 })

  const { iso, diaSemana } = hojeBRT()

  // `sala_canon` e não `sala`: o rótulo cru da planilha ia inteiro pro título da
  // notificação ("Sala 207 (P2) LAB.PROJETOS ELETRICOS/206 (P2)"), e pseudo-sala
  // como CANCELADA e ONLINE, que tem canônica nula de propósito justamente pra
  // não ocupar nada, chegava no aluno como "Sala CANCELADA".
  // `order=capturado.desc` porque sem ordem o PostgREST devolve na ordem física,
  // que muda a cada UPDATE: o dedupe por código guardava uma linha por sorteio e
  // podia mandar o aluno pra sala ANTIGA.
  const mapa: any[] = await rest(
    `mapa_dia?data=eq.${iso}&order=capturado.desc` +
    `&select=codigo,disciplina,horario,professor,sala_canon`)
  const doSlot = mapa.filter((r) => r.codigo && r.sala_canon && slotDoInicio(r.horario) === slot)
  if (!doSlot.length) return Response.json({ enviados: 0, motivo: 'mapa vazio no slot' })
  const porCodigo = new Map<string, any>()
  for (const r of doSlot) if (!porCodigo.has(r.codigo)) porCodigo.set(r.codigo, r)

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
  let limpas = 0
  let falhas = 0
  await Promise.all(subs.map(async (s) => {
    const aulas = porAluno.get(s.aluno_id)!
    const salas = [...new Set(aulas.map((a) => a.sala_canon))]
    const titulo = salas.length === 1 ? `Sala ${salas[0]}` : `Salas ${salas.join(', ')}`
    const corpo = aulas.map((a) =>
      `${a.disciplina} · ${(a.professor || '').split(' ')[0]} · ${a.horario}`).join('\n')
    const r = await enviar(s, { title: titulo, body: corpo, tag: `ibsala-${slot}` })
    if (r === 'enviado') {
      enviados++
    } else if (r === 'morta') {
      // inscrição morta: limpa. O DELETE dentro de um Promise.all sem catch
      // derrubava a resposta inteira DEPOIS dos pushes já terem saído
      try {
        await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`,
          { method: 'DELETE' })
        limpas++
      } catch { /* some na próxima rodada */ }
    } else {
      falhas++
    }
  }))

  // o pg_cron ignora a resposta (net.http_post é fire and forget), então o
  // resultado fica no banco, como a captura já faz com a marca de frescor
  await rest('config?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{
      key: 'ultimo_push',
      value: { em: new Date().toISOString(), slot, enviados, falhas, limpas, alunos: porAluno.size },
    }]),
  }).catch(() => {})

  return Response.json({ enviados, falhas, limpas, alunos: porAluno.size, subs: subs.length })
})
