-- Email (Resend) — produtores da email_queue + cron que drena a fila.
-- A fila guarda JSON {"template":"welcome"|"exclusao","vars":{...}} (renderizado
-- na function send-emails) ou HTML cru; ver send-emails/index.ts.
--
-- Pré-requisitos (uma vez, fora do repo):
--   1. deploy da function:  supabase functions deploy send-emails --no-verify-jwt
--   2. secrets do projeto:  RESEND_API_KEY (key nova, conta ibsala)
--      (CRON_SECRET, SUPABASE_URL, SERVICE_KEY já existem do push-slot)
--   3. domínio mail.ibsala.com.br verificado na conta Resend nova — SÓ depois
--      do email de re-cadastro do cutover (o domínio sai da conta velha; ver
--      runbook do funeral no Cérebro).

-- welcome no cadastro: trigger no insert de alunos
create or replace function public.enqueue_welcome_email()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.email_queue (to_email, subject, body)
  values (
    new.email,
    '[IBSALA] Bem-vindo/a, ' || new.username || '!',
    json_build_object(
      'template', 'welcome',
      'vars', json_build_object('username', new.username)
    )::text
  );
  return new;
end;
$$;

create trigger alunos_welcome_email
  after insert on public.alunos
  for each row execute function public.enqueue_welcome_email();

-- drena a fila a cada 5 min (mesmo padrão do disparar_push_slot: pg_net +
-- CRON_SECRET no Vault)
create or replace function public.disparar_email_drain()
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://jbdmkbivmflauushiqca.supabase.co/functions/v1/send-emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
end;
$$;

select cron.schedule('email-drain', '*/5 * * * *', $$select public.disparar_email_drain()$$);
