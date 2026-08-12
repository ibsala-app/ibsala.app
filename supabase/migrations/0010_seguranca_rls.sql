-- ibsala v5 — fechar escalada de privilégio e as RPCs abertas ao público
--
-- Dois furos confirmados em produção por consulta de leitura (pg_policies,
-- information_schema.role_table_grants, has_function_privilege), não por
-- suspeita de leitura de código:
--
-- 1. `alunos_update_own` foi criada em 0001 SEM `with check`. Quando a policy de
--    UPDATE não define `with check`, o Postgres reaproveita a expressão do
--    `using` para validar a LINHA NOVA. Como o `id` não muda,
--    `update alunos set role='admin' where id = auth.uid()` passa: qualquer
--    aluno logado virava admin numa requisição, e com isso lia email de todos,
--    matéria de todos, a email_queue inteira, bloqueava conta e travava o site.
--    O `alunos_insert_own` já tinha o check certo (`role = 'aluno'`), então o
--    cuidado existia e escapou só no update.
--
-- 2. As três funções `disparar_*` (push, email, captura) são `security definer`,
--    leem o cron_secret do Vault e chamam as edge functions. Função nova no
--    Postgres nasce com `execute to public`, e nenhuma delas tinha `revoke`:
--    `has_function_privilege('anon', ...)` devolvia true. Com a chave
--    publishable, que é pública por design, um POST em
--    /rest/v1/rpc/disparar_push_slot notificava todos os alunos inscritos, na
--    hora que a pessoa quisesse, e o x-cron-secret das functions virava
--    decoração.
--
-- O resto é endurecimento de mesma família, tudo na mesma migration porque
-- nenhum deles vale um deploy separado.

-- ---------------------------------------------------------------------------
-- 1. UPDATE em alunos: with check explícito + guarda por coluna
-- ---------------------------------------------------------------------------

drop policy if exists alunos_update_own on public.alunos;

create policy alunos_update_own on public.alunos
  for update using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- Policy não enxerga OLD, então quem barra troca de coluna é trigger. Trigger em
-- vez de grant por coluna porque o admin também é `authenticated` e precisa
-- continuar escrevendo `bloqueado`.
create or replace function public.alunos_guarda_colunas()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- service_role e pg_cron não têm auth.uid(); ali o RLS já é ignorado de
  -- qualquer jeito, e é a chave de confiança do sistema
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  if new.id is distinct from old.id
     or new.email is distinct from old.email
     or new.role is distinct from old.role
     or new.bloqueado is distinct from old.bloqueado
     or new.criado is distinct from old.criado then
    raise exception 'id, email, role, bloqueado e criado só mudam por admin'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists alunos_guarda_colunas on public.alunos;
create trigger alunos_guarda_colunas
  before update on public.alunos
  for each row execute function public.alunos_guarda_colunas();

-- ---------------------------------------------------------------------------
-- 2. RPCs que só o pg_cron deve chamar
-- ---------------------------------------------------------------------------
-- O pg_cron roda como `postgres` e não perde nada com isto. Mesmo padrão do
-- `revoke` que a 0009 já usa na total_alunos.

revoke all on function public.disparar_push_slot(text) from public, anon, authenticated;
revoke all on function public.disparar_email_drain() from public, anon, authenticated;
revoke all on function public.disparar_captura() from public, anon, authenticated;

-- funções de aluno logado não precisam ficar abertas pro anônimo:
-- `username_disponivel` dava enumeração de usernames de graça
revoke all on function public.username_disponivel(text) from public, anon;
grant execute on function public.username_disponivel(text) to authenticated;

revoke all on function public.touch_ultimo_acesso() from public, anon;
grant execute on function public.touch_ultimo_acesso() to authenticated;

revoke all on function public.exportar_meus_dados() from public, anon;
grant execute on function public.exportar_meus_dados() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. INSERT em alunos: email amarrado ao JWT
-- ---------------------------------------------------------------------------
-- Sem isto dava pra cadastrar o perfil com o email de outra pessoa, e o trigger
-- `alunos_welcome_email` (0004) enfileirava um email com assunto escolhido por
-- quem cadastrou, saindo do domínio verificado do IBSALA.

drop policy if exists alunos_insert_own on public.alunos;

create policy alunos_insert_own on public.alunos
  for insert with check (
    id = auth.uid()
    and role = 'aluno'
    and not bloqueado
    and lower(email) = lower(auth.jwt() ->> 'email')
  );

-- a única validação de username era o .trim() do cliente
alter table public.alunos
  add constraint alunos_username_formato
  check (username ~ '^[a-zA-Z0-9_.]{3,20}$');

-- ---------------------------------------------------------------------------
-- 4. `bloqueado` passa a bloquear de verdade
-- ---------------------------------------------------------------------------
-- Até aqui o campo só era lido pelo push-slot: o admin bloqueava um aluno e ele
-- seguia lendo, cadastrando matéria e abrindo reclamação, só sem receber aviso.
-- Leitura continua liberada (o app é público mesmo); escrita, não.

create or replace function public.esta_bloqueado()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select bloqueado from public.alunos where id = auth.uid()), false);
$$;

revoke all on function public.esta_bloqueado() from public, anon;
grant execute on function public.esta_bloqueado() to authenticated;

drop policy if exists materias_own on public.materias;
create policy materias_own on public.materias
  for all using (aluno_id = auth.uid() or public.is_admin())
  with check ((aluno_id = auth.uid() and not public.esta_bloqueado()) or public.is_admin());

drop policy if exists reclamacoes_insert on public.reclamacoes;
create policy reclamacoes_insert on public.reclamacoes
  for insert with check (aluno_id = auth.uid() and not public.esta_bloqueado());

-- ---------------------------------------------------------------------------
-- 5. config: leitura só das chaves que o app usa
-- ---------------------------------------------------------------------------
-- Hoje só existem `travado` e `ultima_captura`, mas a policy `using (true)`
-- entrega qualquer chave futura pro anônimo sem ninguém perceber.

drop policy if exists config_read on public.config;
create policy config_read on public.config
  for select using (key in ('travado', 'ultima_captura', 'ultimo_email_drain'));

-- ---------------------------------------------------------------------------
-- 6. Grants de escrita nas tabelas que só o service_role escreve
-- ---------------------------------------------------------------------------
-- O RLS já barra (não existe policy de insert/update/delete nelas), então isto é
-- o cinto: no dia em que alguém criar uma policy permissiva sem pensar, o grant
-- não vai estar lá esperando.

revoke insert, update, delete on public.mapa_dia               from anon, authenticated;
revoke insert, update, delete on public.salas                  from anon, authenticated;
revoke insert, update, delete on public.disciplinas_historico  from anon, authenticated;
revoke insert, update, delete on public.salas_pendentes        from anon, authenticated;
revoke insert, update, delete on public.audit_log              from anon, authenticated;
revoke insert, update, delete on public.email_queue            from anon, authenticated;
revoke delete on public.alunos from anon, authenticated;   -- exclusão é pela edge function

-- ---------------------------------------------------------------------------
-- 7. Retenção que estava furada
-- ---------------------------------------------------------------------------
-- `ultimo_acesso` é nullable e `null < x` é null, então conta que nunca chamou
-- touch_ultimo_acesso ficava pra sempre. Hoje são justamente os cadastrados que
-- não voltaram.

select cron.schedule('retencao-lgpd', '30 6 1 * *', $$
  delete from auth.users u
    using public.alunos a
    where a.id = u.id
      and coalesce(a.ultimo_acesso, a.criado) < now() - interval '12 months';
  delete from public.reclamacoes
    where resolvido_em is not null and resolvido_em < now() - interval '6 months';
$$);

-- a fila de email nunca era limpa: o endereço de quem apagou a conta continuava
-- no banco por tempo indeterminado, o que contradiz o art. 18 que a própria
-- edge function apagar-conta cumpre
select cron.schedule('email-queue-retencao', '10 7 * * *', $$
  delete from public.email_queue
    where enviado and criado < now() - interval '30 days';
$$);

-- ---------------------------------------------------------------------------
-- 8. audit_log ligado
-- ---------------------------------------------------------------------------
-- A tabela existe desde a 0001 e nunca recebeu uma linha: bloquear aluno e
-- travar o site não deixavam rastro nenhum. `ip` fica nulo de propósito, o
-- PostgREST não entrega o IP do cliente pro Postgres.

create or replace function public.log_admin_aluno()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.bloqueado is distinct from old.bloqueado then
    insert into public.audit_log (adm, aluno_id, acao)
    values (auth.uid(), new.id,
            case when new.bloqueado then 'bloqueou aluno' else 'desbloqueou aluno' end);
  end if;
  if new.role is distinct from old.role then
    insert into public.audit_log (adm, aluno_id, acao)
    values (auth.uid(), new.id, 'trocou role para ' || new.role);
  end if;
  return new;
end;
$$;

drop trigger if exists alunos_audit on public.alunos;
create trigger alunos_audit
  after update on public.alunos
  for each row execute function public.log_admin_aluno();

create or replace function public.log_admin_config()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.key = 'travado' and new.value is distinct from old.value then
    insert into public.audit_log (adm, acao)
    values (auth.uid(), case when new.value = 'true'::jsonb
                             then 'travou o site' else 'destravou o site' end);
  end if;
  return new;
end;
$$;

drop trigger if exists config_audit on public.config;
create trigger config_audit
  after update on public.config
  for each row execute function public.log_admin_config();
