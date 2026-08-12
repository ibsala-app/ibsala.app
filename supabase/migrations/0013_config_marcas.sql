-- ibsala v5 — as marcas de execução do push e do email entram na allowlist
--
-- `net.http_post` do pg_cron é fire and forget: ninguém lê a resposta das edge
-- functions. A captura já resolvia isso gravando `config.ultima_captura`, que é
-- o que o front mostra na pill de frescor. Agora o push e o drain de email fazem
-- o mesmo, senão fila parada e push que não sai continuam invisíveis até alguém
-- reclamar.
--
-- A 0010 fechou `config_read` numa allowlist de chaves, então as duas novas
-- precisam entrar explicitamente.

drop policy if exists config_read on public.config;

create policy config_read on public.config
  for select using (key in (
    'travado', 'ultima_captura', 'ultimo_email_drain', 'ultimo_push'
  ));
