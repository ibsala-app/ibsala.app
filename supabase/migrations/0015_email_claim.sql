-- ibsala v5 — a fila de email para de poder mandar duas vezes, e passa a caber
-- na cota do Resend
--
-- Dois problemas, medidos na vistoria de 27/08 sobre o `send-emails`:
--
-- 1. NÃO HÁ CLAIM. A function escolhe 50 pendentes, envia, e só depois marca
--    `enviado`. Entre o envio e o UPDATE a linha continua pendente para todo
--    mundo: duas execuções sobrepostas (o cron dispara a cada 5 min e o
--    net.http_post é fire and forget, ninguém garante que a anterior acabou)
--    mandam o mesmo email duas vezes. Com 30 alunos a janela quase nunca abria;
--    com um lote de 1.000 cadastros a fila fica cheia o dia inteiro e a janela
--    passa a ser o estado normal.
--
-- 2. NÃO HÁ TETO. O Resend Free entrega 100 emails por dia e 3.000 por mês. Mil
--    cadastros geram mil welcomes, a conta bate o limite, o Resend responde 429,
--    e o `hold` para a rodada inteira. O onboarding escalonado (decisão do Josh
--    em 27/08) precisa que a fila saiba parar sozinha antes do 429.
--
-- Rollback: drop das duas funções e `alter table ... drop column` das três
-- colunas. Nada aqui reescreve linha existente além do backfill de `enviado_em`,
-- que copia `criado` para o que já foi enviado.

alter table public.email_queue
  add column if not exists lease_ate  timestamptz,
  add column if not exists enviado_em timestamptz,
  add column if not exists idem_key   uuid not null default gen_random_uuid();

-- quem já saiu tem a data de criação como melhor aproximação do envio; sem isto
-- o teto diário contaria a fila histórica inteira como "enviada hoje"
update public.email_queue
   set enviado_em = criado
 where enviado and enviado_em is null;

-- a fila só é lida por "pendente, em ordem de id"
create index if not exists email_queue_pendente_idx
  on public.email_queue (id) where not enviado;

-- ---------------------------------------------------------------------------
-- claim atômico
-- ---------------------------------------------------------------------------
-- `for update skip locked` é o que faz dois workers pegarem conjuntos
-- disjuntos: o segundo não espera o primeiro, ele pula a linha travada. O lease
-- de 5 minutos cobre o caso de a execução morrer no meio (o runtime da edge
-- function tem teto de tempo): a linha volta para a fila sozinha, sem
-- intervenção, e a `idem_key` impede que o reenvio vire email repetido.

create or replace function public.claim_emails(n int)
returns setof public.email_queue
language plpgsql
security definer
set search_path = public
as $$
begin
  if n is null or n <= 0 then
    return;
  end if;

  return query
  update public.email_queue q
     set lease_ate = now() + interval '5 minutes'
   where q.id in (
     select e.id
       from public.email_queue e
      where not e.enviado
        and e.tentativas < 5
        and (e.lease_ate is null or e.lease_ate < now())
      order by e.id
      limit n
      for update skip locked
   )
  returning q.*;
end;
$$;

revoke all on function public.claim_emails(int) from public, anon, authenticated;
grant execute on function public.claim_emails(int) to service_role;

-- ---------------------------------------------------------------------------
-- teto diário
-- ---------------------------------------------------------------------------
-- Janela corrente de 24 h em vez de "dia do calendário" de propósito: a cota do
-- Resend é por dia da conta, e uma janela deslizante nunca estoura um dia civil,
-- qualquer que seja o fuso que eles usem para virar o contador.

create or replace function public.emails_enviados_24h()
returns int
language sql
security definer
stable
set search_path = public
as $$
  select count(*)::int
    from public.email_queue
   where enviado
     and enviado_em is not null
     and enviado_em > now() - interval '24 hours';
$$;

revoke all on function public.emails_enviados_24h() from public, anon, authenticated;
grant execute on function public.emails_enviados_24h() to service_role;
