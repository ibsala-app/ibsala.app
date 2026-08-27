// O repertório saiu de dentro do `captura/index.ts` para ser usado também pela
// captura da pós. Estes testes existem para o movimento ser verificável: são os
// casos que o projeto já pagou caro para aprender, escritos como asserção.

import { assertEquals } from 'jsr:@std/assert@1'
import { carregarRepertorio, chave, resolverSala } from './repertorio.ts'
import { lerCsv } from './csv.ts'

const rep = carregarRepertorio()

Deno.test('canônica direta', () => {
  assertEquals(resolverSala('105', rep), ['105', 'canonica'])
})

Deno.test('a 114 com barra é apelido, e o apelido ganha da regra da barra', () => {
  // 12/08: a regra da barra rodava ANTES do repertório e engolia
  // "114 LAB QUIMICA/FISICA", então a 114 aparecia livre com aula dentro
  assertEquals(resolverSala('114 LAB QUIMICA/FISICA', rep), ['114', 'apelido'])
  assertEquals(resolverSala('114 - LAB. FISICA', rep), ['114', 'apelido'])
})

Deno.test('pontuação não separa rótulo de sala', () => {
  // a chave ignora ponto, parêntese e hífen: foi o conserto do #85/#86
  assertEquals(resolverSala('109 (P2) MAKER', rep), ['P2-109', 'apelido'])
  assertEquals(resolverSala('109 (P2) LAB MAKER', rep), ['P2-109', 'apelido'])
  assertEquals(resolverSala('204 (P2) LAB MAQUETES', rep), ['P2-204', 'apelido'])
})

Deno.test('pseudo-sala não ocupa nada', () => {
  // é o que faz a pós de sala "Remoto" nascer com sala_canon nula em vez de
  // virar "Sala CANCELADA" no título do push
  for (const p of ['CANCELADA', 'ONLINE', 'Remoto', 'remoto', 'A DEFINIR']) {
    assertEquals(resolverSala(p, rep), [null, 'ignorada'], p)
  }
})

Deno.test('barra desconhecida: um lado resolve, ocupa esse lado', () => {
  assertEquals(
    resolverSala('207 (P2) LAB.PROJETOS ELETRICOS/206 (P2)', rep)[1],
    'apelido-barra')
})

Deno.test('barra com dois lados conhecidos fica em quarentena', () => {
  assertEquals(resolverSala('202/203', rep), [null, 'barra-multipla'])
})

Deno.test('rótulo fora do repertório não vira sala por conta própria', () => {
  assertEquals(resolverSala('SALA NOVA QUE NINGUEM CADASTROU', rep),
    [null, 'desconhecida'])
  assertEquals(resolverSala('', rep), [null, 'vazia'])
})

Deno.test('chave normaliza acento, caixa e espaço', () => {
  assertEquals(chave('  Sala   Ámbar (P2) '), 'SALA AMBAR P2')
})

Deno.test('csv do Google: aspas, aspas dobradas, CRLF e BOM', () => {
  assertEquals(
    lerCsv('﻿a,b\r\n"c,1","d ""x"""\n'),
    [['a', 'b'], ['c,1', 'd "x"']])
})

Deno.test('csv: última linha sem quebra não some', () => {
  assertEquals(lerCsv('a,b\nc,d'), [['a', 'b'], ['c', 'd']])
})
