// send-emails: drena a email_queue via Resend (remetente no-reply; Resend é só
// pros emails automáticos — suporte/recebimento é o Gmail ibsala.app@gmail.com).
// Chamada pelo pg_cron a cada 5 min (0004_email.sql) com body {} — pega até 50
// pendentes (enviado=false, tentativas<5) e envia uma a uma (rate limit Resend
// free = 2 req/s). Sucesso marca enviado; falha incrementa tentativas; 429 para
// a rodada e deixa o resto pro próximo tick.
// body da fila: JSON {"template":"welcome"|"exclusao","vars":{...}} renderizado
// aqui, ou HTML cru (comunicados futuros inserem o HTML pronto direto).
// Deploy: supabase functions deploy send-emails --no-verify-jwt
// Secrets: CRON_SECRET, RESEND_API_KEY, SUPABASE_URL, SERVICE_KEY
//          (EMAIL_FROM opcional, default abaixo)

const URL_BASE = Deno.env.get('SUPABASE_URL')!
const KEY = Deno.env.get('SERVICE_KEY')!
const RESEND_KEY = Deno.env.get('RESEND_API_KEY')!
const FROM = Deno.env.get('EMAIL_FROM') ?? 'IBSALA <nao-responda@mail.ibsala.com.br>'

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

// wrapper visual portado do v1 (navy #002555 + ouro #F5AC00, Inter)
function emailWrapper(content: string, subtitle: string): string {
  const sub = subtitle.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const font = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
  return (
    "<!DOCTYPE html><html lang='pt-BR'><head><meta charset='UTF-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');</style>" +
    `</head><body style='margin:0;padding:0;background:#f0f2f5;font-family:${font}'>` +
    "<table width='100%' cellpadding='0' cellspacing='0' border='0' style='background:#f0f2f5'>" +
    "<tr><td style='padding:24px 16px'>" +
    "<table align='center' width='600' cellpadding='0' cellspacing='0' border='0' " +
    "style='background:#ffffff;max-width:600px;margin:0 auto;border:1px solid #dee2e6;border-radius:6px;overflow:hidden'>" +
    "<tr><td style='background:#002555;padding:18px 28px'>" +
    "<table width='100%' cellpadding='0' cellspacing='0' border='0'><tr>" +
    "<td><span style='color:#ffffff;font-size:18px;font-weight:800;letter-spacing:1px'>IBSALA</span>" +
    "<span style='color:rgba(255,255,255,.3);font-size:13px;margin-left:8px'>//</span>" +
    `<span style='color:rgba(255,255,255,.6);font-size:13px;margin-left:6px;font-weight:500'>${sub}</span></td>` +
    "<td align='right'><span style='background:#F5AC00;color:#ffffff;font-size:10px;" +
    "font-weight:700;padding:3px 10px;letter-spacing:1px;border-radius:2px'>IBTECH</span></td>" +
    "</tr></table></td></tr>" +
    `<tr><td style='padding:28px;color:#121212;font-size:14px;line-height:1.7;font-family:${font}'>${content}</td></tr>` +
    "<tr><td style='background:#f8f9fa;padding:14px 28px;border-top:1px solid #dee2e6'>" +
    "<table width='100%' cellpadding='0' cellspacing='0' border='0'><tr>" +
    `<td><p style='margin:0;font-size:11px;color:#888888;font-family:${font}'>` +
    "ibsala.com.br &mdash; consulta de salas e horarios IBtech &middot; " +
    "<a href='mailto:ibsala.app@gmail.com' style='color:#888888;text-decoration:none'>ibsala.app@gmail.com</a></p></td>" +
    "<td align='right'><a href='https://ibsala.com.br' " +
    "style='color:#002555;font-size:11px;font-weight:600;text-decoration:none'>acessar site &rarr;</a></td>" +
    "</tr></table></td></tr>" +
    "</table></td></tr></table></body></html>"
  )
}

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function welcome(vars: Record<string, string>): string {
  const u = esc(vars.username)
  const content =
    `<p style='margin:0 0 20px'>Olá, <strong>${u}</strong>! Bem-vindo/a ao <strong>IBSALA</strong>.</p>` +
    "<div style='background:#ffffff;border:1px solid #dee2e6;border-left:3px solid #002555;padding:14px;margin-bottom:20px'>" +
    "<p style='margin:0 0 6px;font-size:12px;color:#666;font-weight:bold'>SEU ACESSO</p>" +
    `<p style='margin:0 0 4px;font-size:14px'>Username: <strong style='color:#002555'>@${u}</strong></p>` +
    "<p style='margin:0;font-size:12px;color:#666'>Entre sempre com sua conta Google. Não existe senha.</p>" +
    "</div>" +
    "<div style='background:#f0f4ff;border:1px solid #dee2e6;border-left:3px solid #F5AC00;padding:14px;margin-bottom:20px'>" +
    "<p style='margin:0 0 6px;font-size:12px;color:#666;font-weight:bold'>INSTALE O APP NO SEU CELULAR</p>" +
    "<p style='margin:0 0 10px;font-size:13px;color:#333'>O IBSALA funciona como aplicativo — sem precisar de loja de apps.</p>" +
    "<div style='margin-bottom:6px;font-size:13px'><strong style='color:#002555'>iPhone:</strong> " +
    "abra <a href='https://ibsala.com.br' style='color:#002555'>ibsala.com.br</a> no Safari → " +
    "toque em Compartilhar &#9650; → <em>Adicionar à Tela de Início</em></div>" +
    "<div style='font-size:13px'><strong style='color:#002555'>Android:</strong> " +
    "abra no Chrome → toque no menu &#8942; → <em>Adicionar à tela inicial</em></div>" +
    "</div>" +
    "<div style='background:#ffffff;border:1px solid #dee2e6;padding:14px;margin-bottom:20px'>" +
    "<p style='margin:0 0 10px;font-size:12px;color:#666;font-weight:bold'>COMO USAR O IBSALA</p>" +
    "<div style='margin-bottom:8px'><span style='color:#002555;font-weight:bold'>1.</span> " +
    "Acesse <a href='https://ibsala.com.br' style='color:#002555'>ibsala.com.br</a> e toque em <em>Entrar com Google</em></div>" +
    "<div style='margin-bottom:8px'><span style='color:#002555;font-weight:bold'>2.</span> " +
    "Veja suas aulas do dia com sala, horário e professor em tempo real</div>" +
    "<div style='margin-bottom:8px'><span style='color:#002555;font-weight:bold'>3.</span> " +
    "Em <em>Configurações</em>, adicione suas disciplinas</div>" +
    "<div style='margin-bottom:0'><span style='color:#002555;font-weight:bold'>4.</span> " +
    "Instale o app e ative as <strong>notificações push</strong> para receber avisos antes de cada aula</div>" +
    "</div>"
  return emailWrapper(content, 'Bem-vindo/a!')
}

function exclusao(vars: Record<string, string>): string {
  const u = esc(vars.username)
  const content =
    `<p style='margin:0 0 16px'>Olá, <strong>@${u}</strong>.</p>` +
    "<p style='margin:0 0 16px'>Sua conta no IBSALA foi excluída a seu pedido. " +
    "Todos os seus dados (matérias, notificações registradas, reclamações) " +
    "foram removidos do sistema.</p>" +
    "<p style='margin:0 0 16px'>Se foi um engano ou se mudou de ideia, " +
    "basta entrar de novo com sua conta Google em " +
    "<a href='https://ibsala.com.br'>ibsala.com.br</a> — seu cadastro será recriado do zero.</p>" +
    "<p style='margin:0;font-size:12px;color:#888'>Esta é uma mensagem automática.</p>"
  return emailWrapper(content, 'Conta excluída')
}

const TEMPLATES: Record<string, (v: Record<string, string>) => string> = { welcome, exclusao }

function renderBody(body: string): string | null {
  if (!body.trimStart().startsWith('{')) return body // HTML cru
  try {
    const { template, vars } = JSON.parse(body)
    const fn = TEMPLATES[template]
    return fn ? fn(vars ?? {}) : null
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) {
    return new Response('nope', { status: 401 })
  }
  if (!RESEND_KEY) {
    // key ainda não configurada: não queima tentativas da fila
    return Response.json({ enviados: 0, motivo: 'RESEND_API_KEY ausente' })
  }

  const pendentes: any[] = await rest(
    'email_queue?enviado=eq.false&tentativas=lt.5&order=id.asc&limit=50&select=id,to_email,subject,body,tentativas')
  if (!pendentes.length) return Response.json({ enviados: 0, pendentes: 0 })

  let enviados = 0
  let rateLimited = false
  for (const e of pendentes) {
    const html = renderBody(e.body)
    if (html === null) {
      // template desconhecido/JSON quebrado: queima as tentativas pra sair da fila
      await rest(`email_queue?id=eq.${e.id}`, { method: 'PATCH', body: JSON.stringify({ tentativas: 5 }) })
      continue
    }
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [e.to_email], subject: e.subject, html }),
    })
    if (r.ok) {
      await rest(`email_queue?id=eq.${e.id}`, { method: 'PATCH', body: JSON.stringify({ enviado: true }) })
      enviados++
    } else {
      if (r.status !== 429) {
        await rest(`email_queue?id=eq.${e.id}`,
          { method: 'PATCH', body: JSON.stringify({ tentativas: e.tentativas + 1 }) })
      }
      if (r.status === 429) { rateLimited = true; break }
    }
    await new Promise((ok) => setTimeout(ok, 600)) // Resend free: 2 req/s
  }

  return Response.json({ enviados, pendentes: pendentes.length, rateLimited })
})
