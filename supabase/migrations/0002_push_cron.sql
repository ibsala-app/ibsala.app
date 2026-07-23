-- Agenda os disparos de push (~50 min antes de cada slot, dias úteis, BRT=UTC-3).
-- Espelha o v1: 06:40, 09:00, 12:10, 15:00, 17:10, 18:10 BRT.
--
-- Pré-requisitos (uma vez, fora do repo):
--   1. deploy da function:  supabase functions deploy push-slot --no-verify-jwt
--   2. secrets da function: CRON_SECRET, VAPID_*, SUPABASE_URL, SERVICE_KEY
--   3. segredo no Vault:    select vault.create_secret('<CRON_SECRET>', 'cron_secret');

create extension if not exists pg_net;

create or replace function public.disparar_push_slot(slot text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://jbdmkbivmflauushiqca.supabase.co/functions/v1/push-slot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := jsonb_build_object('slot', slot)
  );
end;
$$;

-- horários em UTC (BRT+3); dias úteis
select cron.schedule('push-manha1', '40 9 * * 1-5',  $$select public.disparar_push_slot('manha1')$$);
select cron.schedule('push-manha2', '0 12 * * 1-5',  $$select public.disparar_push_slot('manha2')$$);
select cron.schedule('push-tarde1', '10 15 * * 1-5', $$select public.disparar_push_slot('tarde1')$$);
select cron.schedule('push-tarde2', '0 18 * * 1-5',  $$select public.disparar_push_slot('tarde2')$$);
select cron.schedule('push-noite1', '10 20 * * 1-5', $$select public.disparar_push_slot('noite1')$$);
select cron.schedule('push-noite2', '10 21 * * 1-5', $$select public.disparar_push_slot('noite2')$$);
