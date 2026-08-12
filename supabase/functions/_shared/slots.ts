// Janela de vigência de cada slot, em minutos desde a meia-noite.
//
// Fonte única. A tabela vivia copiada no `web/app.js` e no `push-slot`, e as
// duas cópias JÁ divergiram: quando o front trocou ocupação de "slot do primeiro
// horário" para sobreposição de faixa, o push ficou com a regra velha.
export const SLOTS: Record<string, [number, number]> = {
  manha1: [6 * 60, 9 * 60 + 29],
  manha2: [9 * 60 + 30, 12 * 60 + 59],
  tarde1: [13 * 60, 15 * 60 + 29],
  tarde2: [15 * 60 + 30, 17 * 60 + 59],
  noite1: [18 * 60, 18 * 60 + 59],
  noite2: [19 * 60, 23 * 60 + 59],
}

/** Todos os HH:MM do rótulo, em minutos. A fonte escreve "18:40/22:30" e às
 *  vezes com typo no meio ("11/:00/18:00"): varrer sobrevive aos dois, enquanto
 *  `split('/')[0]` devolvia "11" e a linha sumia do slot. */
export function faixaHoraria(h: unknown): [number, number] | null {
  const hs = [...String(h ?? '').matchAll(/(\d{1,2}):(\d{2})/g)]
    .map((m) => +m[1] * 60 + +m[2])
  if (!hs.length) return null
  return [hs[0], hs.length > 1 ? hs[hs.length - 1] : hs[0]]
}

/** Slot em que a aula COMEÇA. É o que o push quer: avisar ~50 min antes do
 *  início, não em todo slot que a aula atravessa. */
export function slotDoInicio(h: unknown): string | null {
  const f = faixaHoraria(h)
  if (!f) return null
  for (const [k, [a, b]] of Object.entries(SLOTS)) if (f[0] >= a && f[0] <= b) return k
  return null
}

/** Data e dia da semana em Sao Paulo. O `toLocaleDateString` sem `timeZone` só
 *  acerta porque o runtime da edge function é UTC. */
export function hojeBRT() {
  const tz = { timeZone: 'America/Sao_Paulo' } as const
  const agora = new Date()
  const dias = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const curto = new Intl.DateTimeFormat('en-US', { weekday: 'short', ...tz })
    .format(agora).toLowerCase().slice(0, 3)
  return {
    iso: agora.toLocaleDateString('sv-SE', tz),
    diaSemana: dias.indexOf(curto),      // 1=SEG … 6=SAB (materias.dia)
  }
}
