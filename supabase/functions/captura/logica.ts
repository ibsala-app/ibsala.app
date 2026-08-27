// captura, a parte que dá pra testar: ler o CSV da planilha da faculdade e
// resolver a sala de cada linha.
//
// Mora fora do `index.ts` porque `Deno.serve` no topo do módulo sobe um servidor
// assim que alguém importa o arquivo. Com o parser aqui, o CI compara o payload
// do TypeScript com o do Python usando a MESMA fixture, sem precisar da function
// no ar: até agora só o parser Python tinha teste direto, e o portão de paridade
// (scripts/paridade-captura.py) depende da edge function deployada.

import { lerCsv } from '../_shared/csv.ts'
import { chave, ladosDaBarra, type Repertorio, resolverSala, semAcento } from '../_shared/repertorio.ts'

export const TITULOS_CATEGORIA = [
  'GRADUAÇÃO - MANHÃ',
  'GRADUAÇÃO - TARDE',
  'GRADUAÇÃO - NOITE',
  'OUTRAS RESERVAS - NOITE',
]

// ── normalização ─────────────────────────────────────────────────────────────

/** Data de hoje em BRT. Entra por parâmetro em `parsear` para o teste poder
 *  fixar o dia e comparar com o golden do parser Python. */
export function hojeISO(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' })
}

export function extrairCodigo(texto: unknown): [string, string] {
  const s = String(texto ?? '')
  if (s.includes('/')) {
    const i = s.indexOf('/')
    return [s.slice(0, i).trim(), s.slice(i + 1).trim()]
  }
  return ['', s.trim()]
}

export function anotarCanonicas(linhas: any[], rep: Repertorio) {
  const pendentes: Record<string, number> = {}
  const multiplas: Record<string, string[]> = {}
  for (const l of linhas) {
    const bruta = String(l.sala ?? '').trim()
    const [canon, motivo] = resolverSala(bruta, rep)
    l.sala_canon = canon
    if (motivo === 'desconhecida') pendentes[bruta] = (pendentes[bruta] ?? 0) + 1
    else if (motivo === 'barra-multipla') multiplas[bruta] = ladosDaBarra(bruta, rep)
  }
  return { pendentes, multiplas }
}

/** Replica parsear() do Python: seções por título de categoria, linha-header
 *  começando em "Turma", valores até a próxima seção. */
export function parsear(textoCsv: string, hoje = hojeISO()): any[] {
  const registros: Record<string, string>[] = []
  let categoria: string | null = null
  let colunas: string[] | null = null

  for (const valores of lerCsv(textoCsv)) {
    const col0 = (valores[0] ?? '').trim()
    const restoVazio = valores.slice(1).every((v) => !v.trim())

    if (TITULOS_CATEGORIA.includes(col0) && restoVazio) {
      categoria = col0
      colunas = null
      continue
    }
    if (col0 === 'Turma' && categoria) {
      colunas = valores.map((v, i) => (v.trim() ? semAcento(v) : `col${i}`))
      continue
    }
    if (categoria && colunas && col0 && col0 !== 'nan') {
      const vals = [...valores]
      while (vals.length < colunas.length) vals.push('')
      const reg: Record<string, string> = { Categoria: categoria }
      colunas.forEach((col, i) => { reg[col] = (vals[i] ?? '').trim() })
      if (Object.entries(reg).some(([k, v]) => k !== 'Categoria' && v)) registros.push(reg)
    }
  }

  // coluna de horário costuma vir sem header ("colN"); primeira vazia vira Horario
  for (const reg of registros) {
    if (!('Horario' in reg)) {
      for (const k of Object.keys(reg)) {
        if (k.startsWith('col')) { reg.Horario = reg[k]; delete reg[k]; break }
      }
    }
  }

  const linhas: any[] = []
  for (const reg of registros) {
    // linha sem disciplina e sem horário não é aula (título perdido, subtotal)
    if (!(reg.Disciplina ?? '').trim() && !(reg.Horario ?? '').trim()) continue
    const [codigo, disciplina] = extrairCodigo(reg.Disciplina ?? '')
    linhas.push({
      data: hoje,
      categoria: reg.Categoria,
      turma: reg.Turma ?? '',
      codigo,
      disciplina,
      horario: reg.Horario ?? '',
      professor: reg.Professor ?? '',
      sala: reg.Salas ?? reg.Sala ?? '',
    })
  }
  return linhas
}
