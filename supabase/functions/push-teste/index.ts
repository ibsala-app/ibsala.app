// push-teste: manda UM aviso de teste pras inscrições de quem chamou, e só pras
// dele. Existe porque o app não tinha como provar entrega: o interruptor mostra
// que a inscrição existe, e "existe" não é "chega". O push-slot não serve pra
// isso, porque exige o x-cron-secret e monta a audiência do mapa do dia, então
// fora de horário letivo ele responde "mapa vazio no slot" e não manda nada.
// Deploy: supabase functions deploy push-teste --no-verify-jwt
// (a autenticação é feita aqui dentro via getUser; CORS liberado pro app)
// Secrets: SUPABASE_URL, SERVICE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY

import { createClient } from 'npm:@supabase/supabase-js@2'
import { enviar } from '../_shared/webpush.ts'

// mesma allowlist do apagar-conta: com `*`, qualquer página que tivesse
// conseguido um token do aluno podia gastá-lo aqui
const ORIGENS = new Set([
  'https://ibsala.com.br',
  'https://www.ibsala.com.br',
  'https://ibsala.pages.dev',
])

function cors(req: Request) {
  const origem = req.headers.get('Origin') ?? ''
  return {
    'Access-Control-Allow-Origin': ORIGENS.has(origem) ? origem : 'https://ibsala.com.br',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

Deno.serve(async (req) => {
  const CORS = cors(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') {
    return new Response('método não permitido', { status: 405, headers: CORS })
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SERVICE_KEY')!)
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data.user) {
    return new Response('não autenticado', { status: 401, headers: CORS })
  }

  // o filtro por aluno é o que impede esta function de virar um megafone: a
  // service key ignora RLS, então o dono do push é decidido aqui, pelo JWT
  const { data: subs } = await admin.from('push_subscriptions')
    .select('endpoint,p256dh,auth').eq('aluno_id', data.user.id)

  if (!subs?.length) {
    return Response.json({ enviados: 0, motivo: 'sem inscricao' }, { headers: CORS })
  }

  let enviados = 0
  let limpas = 0
  let falhas = 0
  for (const s of subs) {
    const r = await enviar(s, {
      title: 'Teste do IBSALA',
      body: 'Se você está lendo isso, os avisos funcionam neste aparelho.',
      tag: 'ibsala-teste',
    })
    if (r === 'enviado') {
      enviados++
    } else if (r === 'morta') {
      // a inscrição morreu no push service: apagar aqui é o que faz o
      // interruptor da tela de Ajustes parar de mentir na próxima carga
      await admin.from('push_subscriptions').delete().eq('endpoint', s.endpoint)
      limpas++
    } else {
      falhas++
    }
  }

  return Response.json({ enviados, limpas, falhas }, { headers: CORS })
})
