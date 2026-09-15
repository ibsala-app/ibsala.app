// Push services que recebem inscrição do IBSALA. É a mesma lista da constraint
// `push_endpoint_conhecido` (migration 0020): o banco recusa a inscrição e as
// functions recusam o envio, então linha antiga que escapou da constraint (ela
// entra `not valid`) também não sai do servidor.
//
// Existe porque `push_subscriptions.endpoint` era texto livre, e o web-push faz
// um POST TLS no host, porta e caminho que estiverem ali. Um aluno com conta
// Google gravava `https://127.0.0.1:5432/` ou um servidor que aceita a conexão e
// não responde: o primeiro vira varredura de rede feita pelo Supabase, com o
// `push-teste` devolvendo `falhas` como oráculo; o segundo segurava o envio 15 s
// por endpoint, e 20 contas com 10 endpoints cada prendiam o `push-slot` perto
// do teto de execução, deixando sem aviso quem vinha depois na fila.

const HOSTS = /^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)\//

/** Chrome, Android, Opera e Samsung usam o FCM; Firefox, o autopush da Mozilla;
 *  Safari e iPhone, o da Apple; Edge, o WNS da Microsoft. */
export function endpointConhecido(endpoint: string): boolean {
  return typeof endpoint === 'string' && endpoint.length <= 1024 && HOSTS.test(endpoint)
}
