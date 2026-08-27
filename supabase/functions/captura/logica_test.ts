// Paridade Python x TypeScript pelo GOLDEN, sem depender da function no ar.
//
// A captura foi portada do Python pro TS quando o agendador virou pg_cron, e
// porte de parser é exatamente onde defeito como o da 114 volta: sala que
// aparece livre com aula dentro. O portão que existia (scripts/paridade-captura.py)
// exige a edge function DEPLOYADA, então no CI só o parser Python era testado de
// verdade. Aqui os dois lados respondem pela mesma fixture e pelo mesmo golden.
//
// O golden nasce do parser Python (`capture/fixtures/paridade-golden.json`), e o
// teste do Python confere contra o MESMO arquivo. Divergir num lado só quebra.

import { assertEquals } from 'jsr:@std/assert@1'
import { carregarRepertorio } from '../_shared/repertorio.ts'
import { anotarCanonicas, parsear } from './logica.ts'

// import de JSON não pede permissão de leitura, então o teste roda com
// `deno test` seco, sem flag nenhuma no CI. O CSV vai dentro do golden, e o
// teste do Python confere que ele é byte a byte o arquivo da pasta.
import golden from '../../../capture/fixtures/paridade-golden.json' with { type: 'json' }

const csv: string = golden.csv

function payload() {
  // a data sai do payload: ela é o dia da execução, e o golden precisa valer
  // amanhã também
  const linhas = parsear(csv, 'GOLDEN').map((l: any) => {
    const { data: _, ...resto } = l
    return resto
  })
  const rep = carregarRepertorio()
  const { pendentes, multiplas } = anotarCanonicas(linhas, rep)
  return {
    linhas: linhas.length,
    ocupando: linhas.filter((l: any) => l.sala_canon).length,
    quarentena: Object.keys(pendentes).length,
    linhas_detalhe: linhas,
    disciplinas: [...new Set(linhas.filter((l: any) => l.codigo).map((l: any) => l.codigo))].sort(),
    pendentes,
    multiplas,
  }
}

Deno.test('o payload do TypeScript bate com o golden do parser Python', () => {
  const p = payload()
  assertEquals(p.linhas, golden.linhas)
  assertEquals(p.ocupando, golden.ocupando)
  assertEquals(p.quarentena, golden.quarentena)
  assertEquals(p.disciplinas, golden.disciplinas)
  assertEquals(p.pendentes, golden.pendentes)
  assertEquals(p.multiplas, golden.multiplas)
  assertEquals(p.linhas_detalhe, golden.linhas_detalhe)
})

Deno.test('a 114 com barra continua ocupando a 114', () => {
  const l = payload().linhas_detalhe.find((x: any) => String(x.sala).startsWith('114 LAB'))
  assertEquals(l.sala_canon, '114')
})

Deno.test('sala fora do repertório vai pra quarentena, não vira sala', () => {
  assertEquals(payload().pendentes['SALA DO CAFE'], 2)
})

Deno.test('barra com dois lados conhecidos não ocupa nenhum dos dois', () => {
  assertEquals(payload().multiplas['302/303'], ['302', '303'])
  const l = payload().linhas_detalhe.find((x: any) => x.sala === '302/303')
  assertEquals(l.sala_canon, null)
})
