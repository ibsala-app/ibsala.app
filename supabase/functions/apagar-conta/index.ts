// apagar-conta: self-delete LGPD. O aluno chama autenticado; o cascade das FKs
// (alunos → materias/push/reclamacoes) limpa tudo junto com o auth.users.
// Deploy: supabase functions deploy apagar-conta --no-verify-jwt
// (a autenticação é feita aqui dentro via getUser; CORS liberado pro app)

import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SERVICE_KEY')!)
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data.user) {
    return new Response('não autenticado', { status: 401, headers: CORS })
  }

  // perfil antes do delete (o cascade leva a linha de alunos junto)
  const { data: aluno } = await admin
    .from('alunos').select('email, username').eq('id', data.user.id).single()

  const { error: e2 } = await admin.auth.admin.deleteUser(data.user.id)
  if (e2) return new Response('falha ao excluir', { status: 500, headers: CORS })

  // confirmação de exclusão (best-effort; o cron email-drain envia)
  if (aluno?.email) {
    await admin.from('email_queue').insert({
      to_email: aluno.email,
      subject: '[IBSALA] Sua conta foi excluída',
      body: JSON.stringify({ template: 'exclusao', vars: { username: aluno.username } }),
    })
  }

  return Response.json({ ok: true }, { headers: CORS })
})
