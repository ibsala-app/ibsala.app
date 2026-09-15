-- ibsala v5: inscrição de push só em push service conhecido
--
-- `push_subscriptions.endpoint` era texto livre desde a 0001, e a RLS só dizia
-- de quem era a linha. Como o web-push faz um POST TLS no host, porta e caminho
-- do endpoint, qualquer conta Google gravava até 10 URLs à escolha dela (quota
-- da 0016) e o servidor batia nelas:
--
-- 1. `push-teste`, que o aluno chama quando quer e sem limite, virava varredura
--    de rede feita a partir do Supabase, com `{enviados, limpas, falhas}` e o
--    tempo de resposta servindo de oráculo de porta aberta.
-- 2. Um servidor que aceita a conexão e não responde segurava cada envio 15 s
--    (o `timeout` do web-push não dispara no Deno, só o `Promise.race`). Vinte
--    contas com 10 endpoints desses prendiam o `push-slot` perto do teto de
--    execução, e quem vinha depois na fila ficava sem aviso da aula.
--
-- A lista é a mesma de `supabase/functions/_shared/push-hosts.ts`, que barra o
-- envio também. `not valid` porque a constraint vale para toda escrita nova sem
-- reprovar a migration por linha antiga; conferir antes do `validate`:
--   select endpoint from push_subscriptions where endpoint !~ '<regex abaixo>';
--
-- p256dh é um ponto P-256 em base64url (87 caracteres) e auth tem 16 bytes (22):
-- os tetos só impedem texto gigante, que antes não tinha limite nenhum.
--
-- Rollback: alter table public.push_subscriptions drop constraint push_endpoint_conhecido;

alter table public.push_subscriptions
  add constraint push_endpoint_conhecido check (
    endpoint ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/'
    and char_length(endpoint) <= 1024
    and char_length(p256dh) <= 128
    and char_length(auth) <= 64
  ) not valid;
