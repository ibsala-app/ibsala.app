// push-slot: dispara web push "sua sala é X" pros alunos com aula no slot.
// Chamada pelo pg_cron (~50 min antes de cada slot) com {"slot":"manha1"}.
// Deploy: supabase functions deploy push-slot --no-verify-jwt
// Secrets da function: CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
//                      SUPABASE_URL, SERVICE_KEY
//
// O miolo mora em `logica.ts` e é testado em `logica_test.ts`: aqui ficam só
// segredo, ambiente e a marca de frescor.

import { segredoConfere } from '../_shared/cron.ts'
import { hojeBRT, SLOTS } from '../_shared/slots.ts'
import { enviar } from '../_shared/webpush.ts'
import { executar } from './logica.ts'
import { avisar, reportar, servir } from '../_shared/sentry.ts'
import { buscar } from '../_shared/retentar.ts'

const URL_BASE = Deno.env.get('SUPABASE_URL')!
const KEY = Deno.env.get('SERVICE_KEY')!

async function rest(path: string, init: RequestInit = {}) {
  const r = await buscar(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  // upsert sem `return=representation` responde 201 com corpo VAZIO, e o
  // `r.json()` lançava depois da escrita já feita. O `.catch(() => {})` da marca
  // de frescor engolia isso; o Sentry pegou na primeira rodada (IBSALA-Z)
  const corpo = await r.text()
  return corpo ? JSON.parse(corpo) : null
}

servir('push-slot', async (req) => {
  if (!await segredoConfere(req)) return new Response('nope', { status: 401 })
  const { slot } = await req.json().catch(() => ({}))
  if (!SLOTS[slot]) return new Response('slot inválido', { status: 400 })

  const { iso, diaSemana, minutos } = hojeBRT()
  const saida = await executar({ rest, enviar, slot, iso, diaSemana, agoraMin: minutos })
  // O cron só roda em dia útil, então slot sem aula nenhuma no mapa é captura
  // parada ou cabeçalho trocado (05/10: `Horários`), não dia vazio. Em feriado
  // isto avisa à toa, uma issue só, que é o preço de não descobrir pelo aluno.
  if (saida.motivo === 'mapa vazio no slot') {
    avisar(`push-slot ${slot}: mapa vazio no slot`, 'warning', { slot, iso })
  }
  if (saida.falhas) {
    avisar(`push-slot ${slot}: ${saida.falhas} envio(s) falharam`, 'warning', { slot, ...saida })
  }

  // o pg_cron ignora a resposta (net.http_post é fire and forget), então o
  // resultado fica no banco, como a captura já faz com a marca de frescor
  await rest('config?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{
      key: 'ultimo_push',
      value: {
        em: new Date().toISOString(),
        slot,
        enviados: saida.enviados,
        falhas: saida.falhas,
        limpas: saida.limpas,
        alunos: saida.alunos,
      },
    }]),
  }).catch((e) => reportar(e, { etapa: 'marca ultimo_push', slot }))

  return Response.json(saida)
}, { cron: true })
