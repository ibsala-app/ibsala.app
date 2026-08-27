// Testes da leitura da planilha da pós. A fixture é a fonte REAL de 27/08/2026,
// baixada do export público e copiada byte a byte (268 bytes), porque teste de
// captura que inventa o formato não prova nada sobre a captura.

import { assert, assertEquals } from 'jsr:@std/assert@1'
import { analisar, lerData } from './logica.ts'

const REAL = `,MAPA DE SALAS,,,
,,,,
,,,,
DATA:25/08/2026(Terça-Feira)      ,,,,
SALA,CURSO,,DISCIPLINA,PROFESSOR(A)
Remoto,LLM EM DIREITO EMPRESARIAL + LLM EM DIREITO TRIBUTÁRIO E CONTABILIDADE TRIBUTÁRIA,20251B,Trabalho de Conclusão de Curso,Pedro Silveira Campos Soares`

const CABECALHO = 'SALA,CURSO,,DISCIPLINA,PROFESSOR(A)'

Deno.test('a fonte real de 27/08 é lida inteira', () => {
  const a = analisar(REAL)
  assert(a.estado === 'ok')
  assertEquals(a.data_fonte, '2026-08-25')
  assertEquals(a.linhas.length, 1)
  const l = a.linhas[0]
  assertEquals(l.sala_raw, 'Remoto')
  assertEquals(l.sala_canon, null)
  assertEquals(l.modalidade, 'remoto')
  assertEquals(l.coluna_c_raw, '20251B')
  assertEquals(l.disciplina, 'Trabalho de Conclusão de Curso')
  assertEquals(l.professor, 'Pedro Silveira Campos Soares')
  assertEquals(l.horario, null)
  assertEquals(l.afeta_ocupacao, false)
})

Deno.test('a data sai da planilha, não do relógio do servidor', () => {
  assertEquals(lerData('DATA:25/08/2026(Terça-Feira)      '), '2026-08-25')
  assertEquals(lerData('DATA: 1/9/2026 (Terça)'), '2026-09-01')
  assertEquals(lerData('DATA:32/08/2026'), null)
  assertEquals(lerData('DATA:25/13/2026'), null)
  assertEquals(lerData('terça-feira'), null)
})

Deno.test('sem data legível a fonte é degradada, e não vira o dia de hoje', () => {
  const a = analisar(`,MAPA DE SALAS,,,\n,,,,\n${CABECALHO}\nRemoto,X,20251B,Y,Z`)
  assert(a.estado === 'degradado')
  assertEquals(a.motivo, 'data-ilegivel')
})

Deno.test('cabeçalho diferente é degradado, não é linha de dado', () => {
  const a = analisar(
    'DATA:25/08/2026\nSALA,CURSO,HORARIO,DISCIPLINA,PROFESSOR(A)\nP2-204,X,10:00,Y,Z')
  assert(a.estado === 'degradado')
  assertEquals(a.motivo, 'cabecalho-diferente')
})

Deno.test('HTML no lugar da planilha é degradado', () => {
  const a = analisar('<!DOCTYPE html><html><head><title>Fazer login</title>')
  assert(a.estado === 'degradado')
  assertEquals(a.motivo, 'cabecalho-diferente')
})

Deno.test('planilha válida e vazia é dia sem aula, não fonte quebrada', () => {
  const a = analisar(`DATA:27/08/2026(Quinta-Feira)\n${CABECALHO}\n,,,,\n,,,,`)
  assert(a.estado === 'ok')
  assertEquals(a.data_fonte, '2026-08-27')
  assertEquals(a.linhas.length, 0)
})

Deno.test('sala física da pós resolve pelo repertório da graduação', () => {
  const a = analisar(
    `DATA:27/08/2026\n${CABECALHO}\n204 (P2) LAB MAQUETES,MBA,20251B,Projeto,Fulano`)
  assert(a.estado === 'ok')
  assertEquals(a.linhas[0].sala_canon, 'P2-204')
  assertEquals(a.linhas[0].modalidade, 'presencial')
  // mesmo com sala física de verdade, a linha não ocupa nada enquanto a fonte
  // não tiver horário
  assertEquals(a.linhas[0].afeta_ocupacao, false)
})

Deno.test('sala fora do repertório não vira sala, e a linha não some', () => {
  const a = analisar(
    `DATA:27/08/2026\n${CABECALHO}\nSALA QUE NINGUEM CADASTROU,MBA,20251B,Projeto,Fulano`)
  assert(a.estado === 'ok')
  assertEquals(a.linhas.length, 1)
  assertEquals(a.linhas[0].sala_canon, null)
  assertEquals(a.linhas[0].sala_raw, 'SALA QUE NINGUEM CADASTROU')
})

Deno.test('linha só com professor ainda é linha; linha vazia não', () => {
  const a = analisar(`DATA:27/08/2026\n${CABECALHO}\n,,,,Fulano\n,,,,\n,,,,`)
  assert(a.estado === 'ok')
  assertEquals(a.linhas.length, 1)
})

Deno.test('campo com vírgula entre aspas não parte a linha', () => {
  const a = analisar(
    `DATA:27/08/2026\n${CABECALHO}\nRemoto,"LLM EM DIREITO, TRIBUTÁRIO",20251B,TCC,Pedro`)
  assert(a.estado === 'ok')
  assertEquals(a.linhas[0].curso, 'LLM EM DIREITO, TRIBUTÁRIO')
})
