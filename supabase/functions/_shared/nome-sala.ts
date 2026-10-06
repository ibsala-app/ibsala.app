// Nome que o aluno LÊ, que nem sempre é a canônica.
//
// Desde a migration 0025 a canônica é o número da porta, e os laboratórios
// viraram codinome: 217 no banco, "2L1" na placa. Só que a planilha do Ibmec e
// todo mundo no corredor chamam esses quatro pelo código, e "Sala 217" no aviso
// não dizia nada pra quem tem aula no 2L1. O 1L1 fica de fora de propósito: a
// planilha escreve 102.
//
// A canônica não muda (ocupação, repertório e busca seguem pela porta); isto é
// só rótulo. O `web/app.js` carrega a mesma tabela, porque o site é estático e
// não importa daqui: mexeu numa, mexe na outra.
export const PELO_CODINOME: Record<string, string> = {
  '217': '2L1',
  '207': '2L2',
  '315': '3L1',
  '307': '3L2',
}

export const nomeSala = (canon: string): string => PELO_CODINOME[canon] ?? canon
