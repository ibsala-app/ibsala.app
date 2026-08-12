// Porta de entrada das functions que o pg_cron chama com `--no-verify-jwt`:
// quem autoriza é o header x-cron-secret, e mais nada.
//
// A comparação é de tempo constante. Ataque de timing por HTTP é impraticável na
// prática (o jitter da rede é ordens de grandeza maior que a diferença), então
// isto é higiene, não conserto de furo. O que era furo de verdade estava do lado
// do banco: as funções `disparar_*` nasceram executáveis por `anon`, e qualquer
// um podia disparar a function sem nunca ver este header (migration 0010).

const enc = new TextEncoder()

async function sha256(s: string): Promise<ArrayBuffer> {
  return await crypto.subtle.digest('SHA-256', enc.encode(s))
}

export async function segredoConfere(req: Request): Promise<boolean> {
  const esperado = Deno.env.get('CRON_SECRET')
  // secret ausente falha FECHADO: sem ele a function não autoriza ninguém
  if (!esperado) return false
  const recebido = req.headers.get('x-cron-secret')
  if (!recebido) return false

  // hash dos dois lados iguala o comprimento antes de comparar, senão o próprio
  // tamanho da string vaza pelo tempo
  const [a, b] = await Promise.all([sha256(recebido), sha256(esperado)])
  const x = new Uint8Array(a)
  const y = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}
