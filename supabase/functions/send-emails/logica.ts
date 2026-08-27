// send-emails, a parte que dá pra testar: teto diário, claim atômico e o que
// fazer com cada resposta do Resend.
//
// Rede e envio entram por parâmetro, então o teste roda duas execuções
// concorrentes sobre a mesma fila e conta os envios, que é exatamente o defeito
// que a vistoria de 27/08 achou aqui: sem claim, "selecionar, enviar, marcar" é
// uma janela em que a linha continua pendente para todo mundo.

export type Rest = (path: string, init?: RequestInit) => Promise<any>

export type Item = {
  id: number
  to_email: string
  subject: string
  body: string
  tentativas: number
  idem_key: string
}

export type Resposta = { ok: boolean; status: number }
export type EnviarEmail = (item: Item, html: string) => Promise<Resposta>

/** Itens por rodada. O cron chama a cada 5 min. */
export const LOTE = 50
/** Resend Free: 100 por dia, 3.000 por mês. */
export const TETO_PADRAO = 100
/** Resend Free aceita 2 requisições por segundo. */
export const PAUSA_MS = 600

export type Saida = {
  enviados: number
  pendentes: number
  hold: number | null
  presos: number
  motivo?: string
}

async function patch(rest: Rest, id: number, campos: Record<string, unknown>) {
  await rest(`email_queue?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(campos) })
}

export async function drenar(dep: {
  rest: Rest
  render: (body: string) => string | null
  enviarEmail: EnviarEmail
  teto?: number
  lote?: number
  pausa?: (ms: number) => Promise<void>
}): Promise<Saida> {
  const { rest, render, enviarEmail } = dep
  const teto = dep.teto ?? TETO_PADRAO
  const lote = dep.lote ?? LOTE
  const pausa = dep.pausa ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)))

  // parar ANTES do 429 é o que faz o onboarding escalonado funcionar: a conta
  // continua sã, o `hold` não é acionado, e o resto da fila espera o dia virar
  const jaSairam: number = (await rest('rpc/emails_enviados_24h',
    { method: 'POST', body: '{}' })) ?? 0
  const vagas = Math.max(0, teto - jaSairam)
  if (!vagas) {
    return { enviados: 0, pendentes: 0, hold: null, presos: 0, motivo: 'teto diário' }
  }

  const claim: Item[] = await rest('rpc/claim_emails',
    { method: 'POST', body: JSON.stringify({ n: Math.min(lote, vagas) }) })
  if (!claim.length) return { enviados: 0, pendentes: 0, hold: null, presos: 0 }

  let enviados = 0
  let hold: number | null = null
  let i = 0
  for (; i < claim.length; i++) {
    const e = claim[i]
    const html = render(e.body)
    if (html === null) {
      // template desconhecido/JSON quebrado: queima as tentativas pra sair da fila
      await patch(rest, e.id, { tentativas: 5, lease_ate: null })
      continue
    }
    const r = await enviarEmail(e, html)
    if (r.ok) {
      await patch(rest, e.id,
        { enviado: true, enviado_em: new Date().toISOString(), lease_ate: null })
      enviados++
    } else if (r.status === 429 || r.status === 401 || r.status === 403) {
      // erro de conta, não do item: não incrementa tentativas de ninguém
      hold = r.status
      break
    } else {
      await patch(rest, e.id, { tentativas: e.tentativas + 1, lease_ate: null })
    }
    await pausa(PAUSA_MS)
  }

  // o que o claim pegou e a rodada não usou volta pra fila agora. Sem isto, um
  // `hold` deixaria até 50 linhas presas pelos 5 minutos do lease sem ninguém
  // ter tentado enviá-las
  const sobra = hold === null ? [] : claim.slice(i)
  if (sobra.length) {
    await rest(`email_queue?id=in.(${sobra.map((s) => s.id).join(',')})`,
      { method: 'PATCH', body: JSON.stringify({ lease_ate: null }) })
  }

  const presos = claim.filter((p) => p.tentativas >= 4).length
  return { enviados, pendentes: claim.length, hold, presos }
}
