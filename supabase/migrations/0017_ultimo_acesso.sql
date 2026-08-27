-- ibsala v5 — `ultimo_acesso` sai do alcance do próprio aluno
--
-- A escalada de `role` foi fechada na 0010 e o aceite dos termos na 0012. Sobrou
-- uma coluna de fora do guarda: `ultimo_acesso`. Ela é o relógio da retenção
-- LGPD, que apaga conta parada há 12 meses usando
-- `coalesce(ultimo_acesso, criado)` (0010). Como a policy de update deixa o dono
-- escrever a própria linha e o trigger não olhava esta coluna, um PATCH direto
-- no PostgREST com o JWT do aluno adiantava o relógio e a conta nunca expirava.
--
-- O jeito certo continua sendo a RPC `touch_ultimo_acesso()`, que é
-- `security definer` e já é a única chamada pelo app. O problema é distinguir
-- "veio da RPC" de "veio do PATCH": dentro de uma função `security definer` o
-- `auth.uid()` continua sendo o do aluno, então o guarda não consegue separar os
-- dois por identidade. A marca de transação resolve: a RPC acende uma flag local
-- (some no fim da transação, não vaza para a conexão seguinte do pool) e o
-- guarda só aceita a escrita quando ela está acesa.
--
-- Rollback: `create or replace` das duas funções com os corpos da 0001 e da
-- 0012.

create or replace function public.touch_ultimo_acesso()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- `true` no terceiro argumento é o que faz a marca ser LOCAL da transação
  perform set_config('ibsala.touch', '1', true);
  update public.alunos set ultimo_acesso = now() where id = auth.uid();
end;
$$;

revoke all on function public.touch_ultimo_acesso() from public, anon;
grant execute on function public.touch_ultimo_acesso() to authenticated;

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
  -- que sai da mão do aluno é só o relógio da retenção
  if new.ultimo_acesso is distinct from old.ultimo_acesso
     and coalesce(current_setting('ibsala.touch', true), '') <> '1' then
    raise exception 'ultimo_acesso só muda pela RPC touch_ultimo_acesso()'
      using errcode = '42501';
  end if;

  return new;
end;
$$;
