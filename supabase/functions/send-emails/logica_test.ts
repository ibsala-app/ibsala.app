// Testes da fila de email sob carga de lançamento: duas execuções sobrepostas,
// teto diário e retomada depois de a execução morrer no meio.
//
// O `rest` de mentira implementa o claim como o Postgres implementa: selecionar
// e travar sem soltar o controle no meio, que é o efeito prático do
// `for update skip locked`.

import { assert, assertEquals } from 'jsr:@std/assert@1'
import { drenar, type Item } from './logica.ts'

type Linha = {
  id: number
  to_email: string
  subject: string
  body: string
  enviado: boolean
  enviado_em: string | null
  tentativas: number
  lease_ate: string | null
  idem_key: string
}

function fila(n: number): Linha[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    to_email: `aluno${i + 1}@ibmec.edu.br`,
    subject: '[IBSALA] Bem-vindo/a',
    body: '{"template":"welcome","vars":{"username":"fulano"}}',
    enviado: false,
    enviado_em: null,
    tentativas: 0,
    lease_ate: null,
    idem_key: `idem-${i + 1}`,
  }))
}

function fakeRest(linhas: Linha[], opcoes: { patchQuebra?: (id: number) => boolean } = {}) {
  const chamadas: string[] = []
  const rest = (caminho: string, init: RequestInit = {}) => {
    chamadas.push(`${init.method ?? 'GET'} ${caminho}`)
    const agora = Date.now()

    if (caminho.startsWith('rpc/emails_enviados_24h')) {
      return Promise.resolve(linhas.filter((l) =>
        l.enviado && l.enviado_em && agora - Date.parse(l.enviado_em) < 24 * 3600_000).length)
    }

    if (caminho.startsWith('rpc/claim_emails')) {
      const { n } = JSON.parse(String(init.body ?? '{}'))
      const pegos = linhas
        .filter((l) => !l.enviado && l.tentativas < 5 &&
          (!l.lease_ate || Date.parse(l.lease_ate) < agora))
        .sort((a, b) => a.id - b.id)
        .slice(0, n)
      // o lease sobe ANTES de devolver, sem await no meio: é isto que o
      // `for update skip locked` garante do lado do banco
      for (const l of pegos) l.lease_ate = new Date(agora + 5 * 60_000).toISOString()
      return Promise.resolve(pegos.map((l) => ({ ...l })))
    }

    if (caminho.startsWith('email_queue?id=eq.')) {
      const id = Number(caminho.split('id=eq.')[1])
      if (opcoes.patchQuebra?.(id)) return Promise.reject(new Error('a function morreu aqui'))
      Object.assign(linhas.find((l) => l.id === id)!, JSON.parse(String(init.body)))
      return Promise.resolve(null)
    }

    if (caminho.startsWith('email_queue?id=in.')) {
      const ids = new Set(caminho.match(/in\.\(([^)]*)\)/)![1].split(',').map(Number))
      const campos = JSON.parse(String(init.body))
      for (const l of linhas) if (ids.has(l.id)) Object.assign(l, campos)
      return Promise.resolve(null)
    }

    throw new Error(`caminho não previsto no teste: ${caminho}`)
  }
  return { rest, chamadas }
}

const render = () => '<p>oi</p>'
const semPausa = () => Promise.resolve()

Deno.test('duas execuções sobrepostas não mandam o mesmo email duas vezes', async () => {
  const linhas = fila(100)
  const { rest } = fakeRest(linhas)
  const saiu: number[] = []

  const worker = () =>
    drenar({
      rest,
      render,
      pausa: semPausa,
      teto: 1000,
      enviarEmail: async (e: Item) => {
        // o envio real leva centenas de ms: é a janela em que a versão antiga
        // deixava a linha pendente para a outra execução
        await new Promise((ok) => setTimeout(ok, 1))
        saiu.push(e.id)
        return { ok: true, status: 200 }
      },
    })

  const [a, b] = await Promise.all([worker(), worker()])

  assertEquals(saiu.length, 100)
  assertEquals(new Set(saiu).size, 100)             // nenhum id duas vezes
  assertEquals(a.enviados + b.enviados, 100)
  assertEquals(linhas.filter((l) => l.enviado).length, 100)
  assertEquals(linhas.filter((l) => l.lease_ate).length, 0)
})

Deno.test('teto diário para a rodada antes de o Resend responder 429', async () => {
  const linhas = fila(30)
  for (const l of linhas.slice(0, 10)) {
    l.enviado = true
    l.enviado_em = new Date().toISOString()
  }
  const { rest, chamadas } = fakeRest(linhas)
  let tentou = 0

  const saida = await drenar({
    rest,
    render,
    pausa: semPausa,
    teto: 10,
    enviarEmail: () => {
      tentou++
      return Promise.resolve({ ok: true, status: 200 })
    },
  })

  assertEquals(saida.motivo, 'teto diário')
  assertEquals(tentou, 0)
  assertEquals(chamadas.filter((c) => c.includes('claim_emails')).length, 0)
})

Deno.test('teto parcial pede só as vagas que sobraram', async () => {
  const linhas = fila(60)
  for (const l of linhas.slice(0, 45)) {
    l.enviado = true
    l.enviado_em = new Date().toISOString()
  }
  const { rest } = fakeRest(linhas)

  const saida = await drenar({
    rest,
    render,
    pausa: semPausa,
    teto: 50,
    enviarEmail: () => Promise.resolve({ ok: true, status: 200 }),
  })

  assertEquals(saida.enviados, 5) // 50 do teto menos 45 que já saíram
})

Deno.test('envio que morreu depois do Resend volta com a MESMA idempotency key', async () => {
  const linhas = fila(3)
  // a linha 1 é enviada, e a function morre antes de marcar `enviado`
  const { rest } = fakeRest(linhas, { patchQuebra: (id) => id === 1 })
  const usadas: string[] = []
  const enviarEmail = (e: Item) => {
    usadas.push(e.idem_key)
    return Promise.resolve({ ok: true, status: 200 })
  }

  await drenar({ rest, render, pausa: semPausa, teto: 100, enviarEmail })
    .catch(() => {/* é exatamente o que acontece quando a execução morre */})

  // o lease segura a linha por 5 min; quando ele vence, ela volta pra fila
  linhas[0].lease_ate = new Date(Date.now() - 1000).toISOString()
  const { rest: rest2 } = fakeRest(linhas)
  await drenar({ rest: rest2, render, pausa: semPausa, teto: 100, enviarEmail })

  assertEquals(linhas[0].enviado, true)
  assertEquals(usadas.filter((k) => k === 'idem-1').length, 2) // o Resend deduplica
})

Deno.test('hold de conta solta o resto do lote na hora', async () => {
  const linhas = fila(10)
  const { rest } = fakeRest(linhas)
  let n = 0

  const saida = await drenar({
    rest,
    render,
    pausa: semPausa,
    teto: 100,
    enviarEmail: () => {
      n++
      return Promise.resolve(n <= 3 ? { ok: true, status: 200 } : { ok: false, status: 429 })
    },
  })

  assertEquals(saida.enviados, 3)
  assertEquals(saida.hold, 429)
  // nenhuma linha fica presa pelos 5 min do lease que esta rodada pediu
  assertEquals(linhas.filter((l) => !l.enviado && l.lease_ate).length, 0)
  assertEquals(linhas.filter((l) => l.tentativas > 0).length, 0)
})

Deno.test('falha do item incrementa tentativas e devolve a linha pra fila', async () => {
  const linhas = fila(2)
  const { rest } = fakeRest(linhas)

  await drenar({
    rest,
    render,
    pausa: semPausa,
    teto: 100,
    enviarEmail: (e: Item) =>
      Promise.resolve(e.id === 1 ? { ok: false, status: 500 } : { ok: true, status: 200 }),
  })

  assertEquals(linhas[0].tentativas, 1)
  assertEquals(linhas[0].lease_ate, null)
  assertEquals(linhas[1].enviado, true)
})

Deno.test('template quebrado sai da fila sem chamar o Resend', async () => {
  const linhas = fila(1)
  const { rest } = fakeRest(linhas)
  let tentou = 0

  await drenar({
    rest,
    render: () => null,
    pausa: semPausa,
    teto: 100,
    enviarEmail: () => {
      tentou++
      return Promise.resolve({ ok: true, status: 200 })
    },
  })

  assertEquals(tentou, 0)
  assertEquals(linhas[0].tentativas, 5)
  assert(!linhas[0].enviado)
})
