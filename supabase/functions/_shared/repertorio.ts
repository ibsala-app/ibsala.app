// Repertório de salas e a normalização que casa o rótulo cru da planilha com a
// sala canônica. Morava dentro do `captura/index.ts`; saiu de lá quando a
// captura da pós passou a precisar do MESMO casamento.
//
// A regra do projeto é dura quanto a isso: a tabela de slots já viveu copiada em
// dois arquivos e as duas cópias divergiram (o push ficou com a regra velha).
// Aqui a fonte é uma só, e quem muda o repertório muda um arquivo.

import repertorioJson from './salas-repertorio.json' with { type: 'json' }

// ── normalização ─────────────────────────────────────────────────────────────

export function semAcento(texto: unknown): string {
  return String(texto ?? '').normalize('NFD').replace(/\p{Mn}/gu, '').trim()
}

/** Chave de casamento: sem acento, SEM pontuação, espaço colapsado, maiúscula.
 *  A barra sobrevive de propósito: resolverSala depende dela. */
export function chave(texto: unknown): string {
  return semAcento(texto).toUpperCase().replace(/[().\-]/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

// ── repertório ───────────────────────────────────────────────────────────────

export type Repertorio = {
  salas: Map<string, string>
  predio: Record<string, string>
  apelidos: Map<string, string>
  ignoradas: Set<string>
}

export function carregarRepertorio(rep = repertorioJson as any): Repertorio {
  // com chave insensível a pontuação dois rótulos podem colapsar; se apontarem
  // pra salas diferentes é ambiguidade silenciosa, e é melhor morrer aqui
  const visto = new Map<string, [string, string, string | null]>()
  const registrar = (rotulo: string, canon: string | null, origem: string) => {
    const k = chave(rotulo)
    const anterior = visto.get(k)
    if (anterior && anterior[2] !== canon) {
      throw new Error(
        `repertório ambíguo: a chave "${k}" sai de ${anterior[0]} ` +
        `"${anterior[1]}" -> ${anterior[2]} e de ${origem} "${rotulo}" -> ${canon}`)
    }
    visto.set(k, [origem, rotulo, canon])
    return k
  }

  const salas = new Map<string, string>()
  const apelidos = new Map<string, string>()
  const ignoradas = new Set<string>()
  for (const s of Object.keys(rep.salas)) salas.set(registrar(s, s, 'canonica'), s)
  for (const [a, c] of Object.entries(rep.apelidos)) {
    apelidos.set(registrar(a, c as string, 'apelido'), c as string)
  }
  for (const i of rep.ignoradas) ignoradas.add(registrar(i, null, 'ignorada'))

  return { salas, predio: { ...rep.salas }, apelidos, ignoradas }
}

export function ladosDaBarra(bruta: string, rep: Repertorio): string[] {
  const achadas: string[] = []
  for (const parte of String(bruta).split('/')) {
    const k = chave(parte)
    if (rep.salas.has(k)) achadas.push(rep.salas.get(k)!)
    else if (rep.apelidos.has(k)) achadas.push(rep.apelidos.get(k)!)
  }
  return [...new Set(achadas)]
}

export function resolverSala(bruta: unknown, rep: Repertorio): [string | null, string] {
  const k = chave(bruta)
  if (!k) return [null, 'vazia']
  if (rep.ignoradas.has(k)) return [null, 'ignorada']
  if (rep.salas.has(k)) return [rep.salas.get(k)!, 'canonica']
  if (rep.apelidos.has(k)) return [rep.apelidos.get(k)!, 'apelido']
  if (k.includes('/')) {
    const lados = ladosDaBarra(String(bruta), rep)
    if (lados.length === 1) return [lados[0], 'apelido-barra']
    if (lados.length > 1) return [null, 'barra-multipla']
    return [null, 'ignorada']
  }
  return [null, 'desconhecida']
}
