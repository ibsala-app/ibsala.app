// captura-pos, a parte que dá pra testar: ler a planilha da coordenação da pós
// e decidir se o que chegou é fonte boa ou estado degradado.
//
// A fonte, inspecionada em 27/08/2026:
//
//   ,MAPA DE SALAS,,,
//   ,,,,
//   ,,,,
//   DATA:25/08/2026(Terça-Feira)      ,,,,
//   SALA,CURSO,,DISCIPLINA,PROFESSOR(A)
//   Remoto,LLM EM DIREITO ...,20251B,Trabalho de Conclusão de Curso,Pedro ...
//
// Três coisas mandam aqui, e nenhuma é negociável:
//
// 1. A DATA VEM DA PLANILHA (A4), nunca do relógio do servidor. No dia da
//    vistoria a fonte dizia 25/08 enquanto o servidor dizia 27/08; trocar em
//    silêncio seria inventar aula.
// 2. NÃO EXISTE COLUNA DE HORÁRIO. Sem horário nenhuma linha pode dizer em qual
//    slot a sala está ocupada, então `afeta_ocupacao` é sempre false nesta fase.
// 3. FONTE ESTRANHA NÃO APAGA NADA. Cabeçalho diferente, HTML de login no lugar
//    do CSV, data ilegível: tudo isso vira estado degradado, o último lote bom
//    fica de pé, e o problema aparece na marca de frescor.
//
// Planilha estruturalmente válida e VAZIA é diferente de fonte quebrada: dia sem
// aula na pós existe, e aí o lote novo é vazio de propósito.

import { lerCsv } from '../_shared/csv.ts'
import { carregarRepertorio, chave, type Repertorio, resolverSala } from '../_shared/repertorio.ts'

export type LinhaPos = {
  sala_raw: string
  sala_canon: string | null
  curso: string
  coluna_c_raw: string
  disciplina: string
  professor: string
  horario: string | null
  modalidade: 'remoto' | 'presencial'
  afeta_ocupacao: false
}

export type Analise =
  | { estado: 'ok'; data_fonte: string; linhas: LinhaPos[] }
  | { estado: 'degradado'; motivo: string }

/** Cabeçalho esperado, por posição. A terceira coluna é vazia na fonte e isso é
 *  parte do formato: se ela ganhar nome, o formato mudou e alguém precisa
 *  olhar. */
const CABECALHO = ['SALA', 'CURSO', '', 'DISCIPLINA', 'PROFESSOR A']

/** Rótulos de sala que significam "não é sala física". O repertório já trata
 *  REMOTO, ONLINE, EAD e HIBRIDO como pseudo-sala desde o v1. */
const NAO_PRESENCIAL = new Set(['REMOTO', 'ONLINE', 'EAD', 'HIBRIDO', 'HIBRIDA'])

/** "DATA:25/08/2026(Terça-Feira)" -> "2026-08-25". Devolve null se não houver
 *  data legível, que é motivo de estado degradado e não de usar hoje. */
export function lerData(texto: unknown): string | null {
  const m = String(texto ?? '').match(/DATA\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i)
  if (!m) return null
  const [, d, mes, ano] = m
  const dia = Number(d)
  const mm = Number(mes)
  if (dia < 1 || dia > 31 || mm < 1 || mm > 12) return null
  return `${ano}-${String(mm).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
}

const igualCabecalho = (valores: string[]) =>
  CABECALHO.every((esperado, i) => chave(valores[i] ?? '') === esperado)

export function analisar(textoCsv: string, rep: Repertorio = carregarRepertorio()): Analise {
  const linhas = lerCsv(textoCsv)
  const iCab = linhas.findIndex(igualCabecalho)
  if (iCab === -1) return { estado: 'degradado', motivo: 'cabecalho-diferente' }

  // a data mora acima do cabeçalho, em célula própria; varrer é mais estável
  // que fixar A4, porque a coordenação já mexeu no topo da planilha antes
  let data: string | null = null
  for (const l of linhas.slice(0, iCab)) {
    for (const c of l) {
      data = data ?? lerData(c)
    }
  }
  if (!data) return { estado: 'degradado', motivo: 'data-ilegivel' }

  const saida: LinhaPos[] = []
  for (const v of linhas.slice(iCab + 1)) {
    const [sala, curso, colC, disciplina, professor] =
      [0, 1, 2, 3, 4].map((i) => String(v[i] ?? '').trim())
    // a planilha tem estilo aplicado até a linha 934 e valor em quase nenhuma:
    // linha sem nada não é aula
    if (!sala && !curso && !disciplina && !professor) continue

    const [canon] = resolverSala(sala, rep)
    saida.push({
      sala_raw: sala,
      sala_canon: canon,
      curso,
      coluna_c_raw: colC,
      disciplina,
      professor,
      // a fonte não tem coluna de horário. Quando tiver, é aqui que ela entra,
      // e só então `afeta_ocupacao` pode virar true
      horario: null,
      modalidade: NAO_PRESENCIAL.has(chave(sala)) ? 'remoto' : 'presencial',
      afeta_ocupacao: false,
    })
  }

  return { estado: 'ok', data_fonte: data, linhas: saida }
}
