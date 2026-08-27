// Testes do push-slot em escala de lançamento. Rodam com `deno test` (job
// `functions` do CI) e nunca tocam a rede: `rest` e `enviar` são de mentira.
//
// O que estes testes travam é o defeito que a vistoria de 27/08 achou: o
// PostgREST corta em 1.000 linhas em silêncio, e com 1.000 alunos o corte cai no
// meio das matérias. Nenhum teste de unidade antigo pegava isso porque a base de
// produção tinha 30 alunos.

import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  emLotes,
  executar,
  maisRecentePorCodigo,
  paginar,
  todasAsSubs,
} from './logica.ts'

type Linha = Record<string, any>

/** PostgREST de mentira: entende `id=gt.`, `limit=`, `in.(...)` e o DELETE por
 *  endpoint, que é tudo o que a function usa. */
function fakeRest(banco: { mapa: Linha[]; materias: Linha[]; subs: Linha[] }) {
  const chamadas: string[] = []
  const rest = (caminho: string, init: RequestInit = {}) => {
    chamadas.push(`${init.method ?? 'GET'} ${caminho}`)
    const limite = Number(caminho.match(/limit=(\d+)/)?.[1] ?? 1e9)
    const depois = Number(caminho.match(/id=gt\.(\d+)/)?.[1] ?? -1)

    if (caminho.startsWith('mapa_dia?')) {
      return Promise.resolve(banco.mapa.filter((l) => l.id > depois).slice(0, limite))
    }
    if (caminho.startsWith('materias?')) {
      return Promise.resolve(banco.materias.filter((l) => l.id > depois).slice(0, limite))
    }
    if (caminho.startsWith('push_subscriptions?aluno_id=in.')) {
      const ids = new Set(caminho.match(/in\.\(([^)]*)\)/)![1].split(','))
      return Promise.resolve(banco.subs.filter((s) => ids.has(s.aluno_id)).slice(0, limite))
    }
    if (caminho.startsWith('push_subscriptions?endpoint=eq.')) {
      const alvo = decodeURIComponent(caminho.split('endpoint=eq.')[1])
      banco.subs = banco.subs.filter((s) => s.endpoint !== alvo)
      return Promise.resolve(null)
    }
    if (caminho.startsWith('config')) return Promise.resolve(null)
    throw new Error(`caminho não previsto no teste: ${caminho}`)
  }
  return { rest, chamadas }
}

function bancoGrande(alunos: number, materiasPorAluno = 2, subsPorAluno = 2) {
  const aulas = ['ARQ1', 'BD2', 'EST3', 'POO4', 'RED5']
  const mapa: Linha[] = aulas.map((codigo, i) => ({
    id: i + 1,
    codigo,
    disciplina: `DISCIPLINA ${codigo}`,
    horario: '07:30/09:20',
    professor: 'Fulano de Tal',
    sala_canon: `P1-10${i}`,
    capturado: '2026-08-27T09:00:00+00:00',
  }))
  const materias: Linha[] = []
  const subs: Linha[] = []
  for (let a = 0; a < alunos; a++) {
    const aluno_id = `aluno-${String(a).padStart(4, '0')}`
    for (let m = 0; m < materiasPorAluno; m++) {
      materias.push({
        id: materias.length + 1,
        aluno_id,
        codigo: aulas[(a + m) % aulas.length],
        disciplina: 'x',
        alunos: { bloqueado: false },
      })
    }
    for (let s = 0; s < subsPorAluno; s++) {
      subs.push(
        { endpoint: `https://push/${aluno_id}/${s}`, p256dh: 'p', auth: 'a', aluno_id })
    }
  }
  return { mapa, materias, subs }
}

Deno.test('paginar varre além do teto de 1.000 linhas', async () => {
  const banco = { mapa: [], materias: [], subs: [] } as any
  banco.materias = Array.from({ length: 2_350 }, (_, i) => ({ id: i + 1, aluno_id: 'x' }))
  const { rest, chamadas } = fakeRest(banco)

  const tudo = await paginar(rest, 'materias?dia=eq.3&select=id')

  assertEquals(tudo.length, 2_350)
  assertEquals(new Set(tudo.map((l) => l.id)).size, 2_350) // nenhuma repetida
  assertEquals(chamadas.length, 3)                         // 1000 + 1000 + 350
  assert(chamadas[1].includes('id=gt.1000'))
})

Deno.test('paginar para quando a resposta vem sem id, sem laço infinito', async () => {
  let voltas = 0
  const rest = () => {
    voltas++
    return Promise.resolve(Array.from({ length: 1000 }, () => ({ codigo: 'X' })))
  }
  const tudo = await paginar(rest, 'mapa_dia?data=eq.2026-08-27')
  assertEquals(voltas, 1)
  assertEquals(tudo.length, 1000)
})

Deno.test('1.500 matérias elegíveis: ninguém fica de fora do aviso', async () => {
  const banco = bancoGrande(750, 2, 2) // 1.500 matérias, 1.500 inscrições
  const { rest } = fakeRest(banco)
  const recebeu: string[] = []

  const saida = await executar({
    rest,
    enviar: (s) => {
      recebeu.push(s.endpoint)
      return Promise.resolve('enviado' as const)
    },
    slot: 'manha1',
    iso: '2026-08-27',
    diaSemana: 3,
  })

  assertEquals(saida.alunos, 750)
  assertEquals(saida.subs, 1_500)
  assertEquals(saida.enviados, 1_500)
  assertEquals(recebeu.length, 1_500)
  assertEquals(new Set(recebeu).size, 1_500) // cada endpoint no máximo uma vez
})

Deno.test('lote de inscrições se parte quando a resposta chega cheia', async () => {
  // 40 alunos com 30 inscrições cada dentro de uma página de 100: a resposta
  // cheia é o único sinal de corte que o PostgREST dá
  const subs: Linha[] = []
  for (let a = 0; a < 40; a++) {
    for (let s = 0; s < 30; s++) {
      subs.push(
        { endpoint: `https://push/${a}/${s}`, p256dh: 'p', auth: 'a', aluno_id: `a${a}` })
    }
  }
  const { rest } = fakeRest({ mapa: [], materias: [], subs })
  const ids = Array.from({ length: 40 }, (_, a) => `a${a}`)

  const achadas = await todasAsSubs(rest, ids, 100)

  assertEquals(achadas.length, 1_200)
  assertEquals(new Set(achadas.map((s) => s.endpoint)).size, 1_200)
})

Deno.test('emLotes respeita o teto de simultâneas', async () => {
  let agora = 0
  let pico = 0
  await emLotes(Array.from({ length: 200 }, (_, i) => i), 20, async () => {
    agora++
    pico = Math.max(pico, agora)
    await new Promise((ok) => setTimeout(ok, 1))
    agora--
  })
  assertEquals(pico, 20)
})

Deno.test('endpoint travado não segura a fila', async () => {
  const banco = bancoGrande(30, 1, 1)
  const { rest } = fakeRest(banco)
  const travado = banco.subs[0].endpoint
  const total = banco.subs.length

  let liberar!: () => void
  const preso = new Promise<void>((ok) => { liberar = ok })
  let terminados = 0
  let quemLiberou = ''
  const socorro = setTimeout(() => {
    quemLiberou ||= 'socorro'
    liberar()
  }, 5_000)

  const saida = await executar({
    rest,
    concorrencia: 5,
    enviar: async (s) => {
      if (s.endpoint === travado) {
        await preso
        return 'enviado' as const
      }
      terminados++
      if (terminados === total - 1) {
        quemLiberou ||= 'os outros'
        liberar()
      }
      return 'enviado' as const
    },
    slot: 'manha1',
    iso: '2026-08-27',
    diaSemana: 3,
  })
  clearTimeout(socorro)

  // se o travado tivesse segurado a fila, quem soltaria seria o socorro
  assertEquals(quemLiberou, 'os outros')
  assertEquals(saida.enviados, total)
})

Deno.test('inscrição morta some da tabela', async () => {
  const banco = bancoGrande(3, 1, 1)
  const { rest } = fakeRest(banco)
  const morta = banco.subs[1].endpoint

  const saida = await executar({
    rest,
    enviar: (s) =>
      Promise.resolve(s.endpoint === morta ? ('morta' as const) : ('enviado' as const)),
    slot: 'manha1',
    iso: '2026-08-27',
    diaSemana: 3,
  })

  assertEquals(saida.limpas, 1)
  assertEquals(saida.enviados, 2)
  assertEquals(banco.subs.some((s) => s.endpoint === morta), false)
})

Deno.test('dedupe por código fica com a captura mais recente, fora de ordem', () => {
  const linhas = [
    { id: 9, codigo: 'BD2', sala_canon: 'P1-101', capturado: '2026-08-27T07:00:00+00:00' },
    { id: 2, codigo: 'BD2', sala_canon: 'P2-204', capturado: '2026-08-27T11:30:00+00:00' },
    { id: 5, codigo: 'BD2', sala_canon: 'P1-999', capturado: '2026-08-27T07:00:00+00:00' },
  ]
  assertEquals(maisRecentePorCodigo(linhas).get('BD2')!.sala_canon, 'P2-204')
})

Deno.test('mapa sem aula no slot não busca matéria nenhuma', async () => {
  const banco = bancoGrande(10, 1, 1)
  banco.mapa = banco.mapa.map((l) => ({ ...l, horario: '19:00/22:30' })) // noite2
  const { rest, chamadas } = fakeRest(banco)

  const saida = await executar({
    rest,
    enviar: () => Promise.resolve('enviado' as const),
    slot: 'manha1',
    iso: '2026-08-27',
    diaSemana: 3,
  })

  assertEquals(saida.motivo, 'mapa vazio no slot')
  assertEquals(chamadas.filter((c) => c.includes('materias')).length, 0)
})
