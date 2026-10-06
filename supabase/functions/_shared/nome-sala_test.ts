import { assertEquals } from 'jsr:@std/assert@1'
import { nomeSala, PELO_CODINOME } from './nome-sala.ts'
import rep from './salas-repertorio.json' with { type: 'json' }

Deno.test('os quatro laboratórios saem pelo código, o resto pela porta', () => {
  assertEquals(['217', '207', '315', '307'].map(nomeSala), ['2L1', '2L2', '3L1', '3L2'])
  assertEquals(nomeSala('102'), '102')
  assertEquals(nomeSala('P2-204'), 'P2-204')
})

Deno.test('cada código exibido é apelido da mesma porta no repertório', () => {
  const apelidos = (rep as any).apelidos as Record<string, string>
  for (const [porta, codigo] of Object.entries(PELO_CODINOME)) {
    assertEquals(apelidos[codigo], porta)
  }
})
