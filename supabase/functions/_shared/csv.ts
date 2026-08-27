// Leitor de CSV do export do Google, compartilhado pelas duas capturas
// (graduação e pós). Saiu do `captura/index.ts` inteiro, sem uma vírgula de
// diferença: as duas fontes são o mesmo `export?format=csv`.

// ── CSV ──────────────────────────────────────────────────────────────────────

/** CSV do export do Google: campo entre aspas, aspas dobradas, CRLF ou LF.
 *  Escrito à mão pra não depender de import externo no caminho do cron. */
export function lerCsv(texto: string): string[][] {
  const linhas: string[][] = []
  let campo = ''
  let linha: string[] = []
  let dentroDeAspas = false
  const t = texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto   // BOM

  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (dentroDeAspas) {
      if (c === '"') {
        if (t[i + 1] === '"') { campo += '"'; i++ } else dentroDeAspas = false
      } else campo += c
      continue
    }
    if (c === '"') { dentroDeAspas = true; continue }
    if (c === ',') { linha.push(campo); campo = ''; continue }
    if (c === '\r') continue
    if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; continue }
    campo += c
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha) }
  return linhas
}
