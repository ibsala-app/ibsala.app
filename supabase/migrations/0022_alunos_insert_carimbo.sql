-- ibsala v5: o servidor carimba as datas do cadastro, e o touch só grava agora
--
-- O guarda de colunas (0010, 0012, 0017) roda em BEFORE UPDATE. No INSERT, que
-- é o instante em que a conta nasce, a policy conferia id, role, bloqueado,
-- email e a presença do aceite, e o resto vinha do corpo da requisição:
--
-- 1. `criado` e `ultimo_acesso` no futuro. A retenção LGPD apaga conta parada
--    há 12 meses por `coalesce(ultimo_acesso, criado)`, então cadastrar com
--    2099 fazia a conta nunca expirar, que era justamente o que a 0017 fechou
--    para o update.
-- 2. `termos_em` com qualquer data e `termos_versao` com qualquer texto,
--    inclusive `0-anterior-aos-termos`, a marca retroativa da 0012 para quem
--    nunca viu os termos. O aceite deixava de ser prova.
--
-- E a flag `ibsala.touch` da 0017 fica acesa até o fim da transação. Numa
-- transação com duas operações (o que o pg_graphql faz com uma mutation de dois
-- campos), o touch acendia a flag e o update seguinte gravava `ultimo_acesso`
-- livre. O guarda agora aceita a escrita só com o valor que o touch grava.
--
-- `termos_em` só é carimbado quando veio preenchido: a policy exige o aceite, e
-- carimbar nulo faria insert sem aceite passar.
--
-- Rollback: drop trigger alunos_carimbo_insert on public.alunos; drop function
-- public.alunos_carimbo_insert(); e `create or replace` do guarda com o corpo da 0017.

create or replace function public.alunos_carimbo_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- service_role, pg_cron e admin seguem livres, como no guarda de update
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  new.criado := now();
  new.ultimo_acesso := now();
  if new.termos_em is not null then
    new.termos_em := now();
  end if;

  -- versão real é `<número>-<data>` (hoje `1-2026-08-12`, no app.js)
  if new.termos_versao is not null
     and new.termos_versao !~ '^[1-9][0-9]*-[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'versão dos termos inválida'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.alunos_carimbo_insert() from public, anon, authenticated;

drop trigger if exists alunos_carimbo_insert on public.alunos;
create trigger alunos_carimbo_insert
  before insert on public.alunos
  for each row execute function public.alunos_carimbo_insert();

create or replace function public.alunos_guarda_colunas()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  if new.id is distinct from old.id
     or new.email is distinct from old.email
     or new.role is distinct from old.role
     or new.bloqueado is distinct from old.bloqueado
     or new.criado is distinct from old.criado
     or new.termos_em is distinct from old.termos_em
     or new.termos_versao is distinct from old.termos_versao then
    raise exception 'id, email, role, bloqueado, criado e aceite dos termos não mudam pelo app'
      using errcode = '42501';
  end if;

  -- `username` e `receber_email` continuam editáveis pela tela de Ajustes: o
  -- que sai da mão do aluno é só o relógio da retenção. `now()` é o início da
  -- transação, o mesmo instante que o touch grava
  if new.ultimo_acesso is distinct from old.ultimo_acesso
     and (coalesce(current_setting('ibsala.touch', true), '') <> '1'
          or new.ultimo_acesso is distinct from now()) then
    raise exception 'ultimo_acesso só muda pela RPC touch_ultimo_acesso()'
      using errcode = '42501';
  end if;

  return new;
end;
$$;
