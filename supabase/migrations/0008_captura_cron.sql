-- ibsala v5 — a captura sai do GitHub Actions e vai pro pg_cron
--
-- Por quê: o cron do `.github/workflows/captura.yml` pede execução a cada 20 min
-- das 07h às 22h em dia útil, ou seja ~48 por dia. O que o GitHub entrega,
-- medido em 100 runs (23/07 a 12/08): 3 em 12/08, 8 em 11/08, 6 em 10/08, 10 em
-- 07/08, 5 em 06/08. Todos verdes, 15s, "upsert ok": não é falha do job, é
-- throttle de schedule do lado do GitHub.
--
-- O efeito no aluno é direto, porque `mapa_dia` guarda só o dia corrente
-- (`mapa-dia-retencao` apaga `data < current_date` às 00:30 BRT): enquanto a
-- primeira captura do dia não cai, o mapa está VAZIO e o app mostra salas livres
-- demais e nenhuma aula. Em 11/08 o primeiro run foi às 07:37 BRT, então isso
-- durou das 00:30 às 07:37, justo na abertura do turno da manhã.
--
-- O pg_cron deste projeto já dispara os 6 pushes (0002) e o email-drain (0004)
-- sem falhar, e é o mesmo agendador que o v1 tinha com APScheduler.
--
-- Pré-requisitos (uma vez, fora do repo):
--   1. deploy da function:  supabase functions deploy captura --no-verify-jwt
--   2. secrets da function: CRON_SECRET, SUPABASE_URL, SERVICE_KEY (já existem,
--      são os mesmos da push-slot)
--   3. segredo no Vault:    'cron_secret' (já existe, criado em 0002)
--   4. portão de paridade:  python3 scripts/paridade-captura.py — payload do
--      Python e da function têm que bater campo a campo antes de agendar
--
-- O `.github/workflows/captura.yml` perde o bloco `schedule` e fica só com
-- `workflow_dispatch`, como plano B manual. O Python continua no repo por uma
-- semana como implementação de referência e fallback.

create extension if not exists pg_net;

create or replace function public.disparar_captura()
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://jbdmkbivmflauushiqca.supabase.co/functions/v1/captura',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
end;
$$;

-- horários em UTC (BRT+3), espelhando os quatro crons do captura.yml
select cron.schedule('captura-dia',     '0,20,40 10-23 * * 1-5', $$select public.disparar_captura()$$);
select cron.schedule('captura-noite',   '0,20,40 0 * * 2-6',     $$select public.disparar_captura()$$);
select cron.schedule('captura-2200',    '0 1 * * 2-6',           $$select public.disparar_captura()$$);
select cron.schedule('captura-matinal', '0 8 * * 1-5',           $$select public.disparar_captura()$$);
