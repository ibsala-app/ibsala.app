-- Testes de RLS, grants e quotas. Rodam no CI contra um banco novo, com TODAS as
-- migrations aplicadas na ordem, e nada aqui sobra: o arquivo inteiro vive numa
-- transação que termina em rollback.
--
-- Existe porque os dois furos mais graves do projeto só apareceram por auditoria
-- manual, em agosto: `alunos_update_own` sem `with check` deixava qualquer aluno
-- logado virar admin, e as três `disparar_*` nasceram executáveis por `anon`.
-- Nenhum teste do repositório olhava para o banco.
--
-- Uso: psql "<url do banco de teste>" -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql

\set ON_ERROR_STOP on
\timing off

begin;

create schema testes;

create function testes.ok(cond boolean, nome text) returns void
language plpgsql as $$
begin
  if cond then
    raise notice '  ok   %', nome;
  else
    raise exception 'FALHOU: %', nome;
  end if;
end;
$$;

/* Roda `sql` com a identidade de um usuário do app e devolve o SQLSTATE do erro,
   ou null quando passou. `set_config(..., true)` é local da transação, então a
   troca de papel não vaza para o teste seguinte. */
create function testes.como(uid uuid, sql text, papel text default 'authenticated',
                            email text default 'a1@ibmec.edu.br')
returns text
language plpgsql as $$
declare
  estado text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', papel, 'email', email)::text, true);
  perform set_config('role', papel, true);
  begin
    execute sql;
    estado := null;
  exception when others then
    estado := SQLSTATE;
  end;
  perform set_config('role', 'postgres', true);
  return estado;
end;
$$;

/* Igual à `como`, mas para pergunta que devolve número. */
create function testes.conta_como(sql text, papel text default 'anon')
returns int
language plpgsql as $$
declare
  n int;
begin
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', papel, true);
  execute sql into n;
  perform set_config('role', 'postgres', true);
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- cenário
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a1@ibmec.edu.br'),
  ('22222222-2222-2222-2222-222222222222', 'a2@ibmec.edu.br'),
  ('33333333-3333-3333-3333-333333333333', 'adm@ibmec.edu.br');

insert into public.alunos (id, username, email, role, bloqueado, termos_em, termos_versao) values
  ('11111111-1111-1111-1111-111111111111', 'aluno.um',  'a1@ibmec.edu.br', 'aluno', false, now(), '1'),
  ('22222222-2222-2222-2222-222222222222', 'aluno.dois','a2@ibmec.edu.br', 'aluno', true,  now(), '1'),
  ('33333333-3333-3333-3333-333333333333', 'admin.um',  'adm@ibmec.edu.br','admin', false, now(), '1');

insert into public.mapa_dia (data, categoria, turma, codigo, disciplina, horario, professor, sala)
values (current_date, 'GRADUAÇÃO - MANHÃ', '3 E.COMP', 'BD2', 'BANCO DE DADOS', '07:30/09:20', 'Fulano', '105');

-- ---------------------------------------------------------------------------
-- 1. escalada de privilégio (o furo da 0010)
-- ---------------------------------------------------------------------------

select testes.ok(
  testes.como('11111111-1111-1111-1111-111111111111',
    $$update public.alunos set role = 'admin' where id = auth.uid()$$) = '42501',
  'aluno não consegue virar admin');

select testes.ok(
  testes.como('11111111-1111-1111-1111-111111111111',
    $$update public.alunos set email = 'outro@ibmec.edu.br' where id = auth.uid()$$) = '42501',
  'aluno não troca o próprio email');

select testes.ok(
  testes.como('11111111-1111-1111-1111-111111111111',
    $$update public.alunos set bloqueado = false where id = auth.uid()$$) is null,
  'update que não mexe em coluna guardada continua passando');

select testes.ok(
  testes.como('11111111-1111-1111-1111-111111111111',
    $$update public.alunos set username = 'novo.nome' where id = auth.uid()$$) is null,
  'aluno continua trocando o próprio username');

-- ---------------------------------------------------------------------------
-- 2. ultimo_acesso (0017)
-- ---------------------------------------------------------------------------

select testes.ok(
  testes.como('11111111-1111-1111-1111-111111111111',
    $$update public.alunos set ultimo_acesso = now() where id = auth.uid()$$) = '42501',
  'aluno não escreve ultimo_acesso direto');

select testes.ok(
  testes.como('11111111-1111-1111-1111-111111111111',
    $$select public.touch_ultimo_acesso()$$) is null,
  'a RPC touch_ultimo_acesso continua funcionando');

select testes.ok(
  (select ultimo_acesso is not null from public.alunos
    where id = '11111111-1111-1111-1111-111111111111'),
  'e a RPC de fato carimbou a coluna');

-- a flag do touch fica acesa até o fim da transação: uma segunda operação na
-- mesma transação (mutation GraphQL de dois campos) não pode escolher o valor
select testes.ok(
  testes.como('11111111-1111-1111-1111-111111111111',
    $$select set_config('ibsala.touch', '1', true)$$) is null,
  'flag do touch acesa, como depois da RPC');

select testes.ok(
  testes.como('11111111-1111-1111-1111-111111111111',
    $$update public.alunos set ultimo_acesso = '2099-01-01' where id = auth.uid()$$) = '42501',
  'com a flag acesa, ultimo_acesso no futuro continua recusado');

select set_config('ibsala.touch', '', true);

-- ---------------------------------------------------------------------------
-- 2b. cadastro: datas e aceite carimbados pelo servidor (0022)
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('44444444-4444-4444-4444-444444444444', 'novo@ibmec.edu.br'),
  ('55555555-5555-5555-5555-555555555555', 'velho@ibmec.edu.br');

select testes.ok(
  testes.como('44444444-4444-4444-4444-444444444444',
    $$insert into public.alunos (id, username, email, criado, ultimo_acesso, termos_em, termos_versao)
      values (auth.uid(), 'aluno.novo', 'novo@ibmec.edu.br',
              '2099-01-01', '2099-01-01', '2099-01-01', '1-2026-08-12')$$,
    'authenticated', 'novo@ibmec.edu.br') is null,
  'cadastro com datas forjadas entra');

select testes.ok(
  (select criado <= now() and ultimo_acesso <= now() and termos_em <= now()
     from public.alunos where id = '44444444-4444-4444-4444-444444444444'),
  'e as três datas saem carimbadas pelo servidor, não pelo corpo');

select testes.ok(
  testes.como('55555555-5555-5555-5555-555555555555',
    $$insert into public.alunos (id, username, email, termos_em, termos_versao)
      values (auth.uid(), 'aluno.velho', 'velho@ibmec.edu.br', now(), '0-anterior-aos-termos')$$,
    'authenticated', 'velho@ibmec.edu.br') = '23514',
  'cadastro novo não usa a versão retroativa dos termos');

select testes.ok(
  testes.como('55555555-5555-5555-5555-555555555555',
    $$insert into public.alunos (id, username, email)
      values (auth.uid(), 'aluno.velho', 'velho@ibmec.edu.br')$$,
    'authenticated', 'velho@ibmec.edu.br') = '42501',
  'cadastro sem aceite continua recusado');

-- ---------------------------------------------------------------------------
-- 3. aluno bloqueado
-- ---------------------------------------------------------------------------

select testes.ok(
  testes.como('22222222-2222-2222-2222-222222222222',
    $$insert into public.materias (aluno_id, dia, turma, disciplina, codigo)
      values (auth.uid(), 3, '3 E.COMP', 'BANCO DE DADOS', 'BD2')$$) = '42501',
  'aluno bloqueado não cadastra matéria');

-- ---------------------------------------------------------------------------
-- 4. RPCs que só o cron pode chamar (o segundo furo da 0010)
-- ---------------------------------------------------------------------------

select testes.ok(
  testes.como(null, $$select public.disparar_push_slot('manha1')$$, 'anon') = '42501',
  'anon não dispara push');

select testes.ok(
  testes.como(null, $$select public.disparar_captura()$$, 'anon') = '42501',
  'anon não dispara captura');

select testes.ok(
  testes.como(null, $$select public.disparar_email_drain()$$, 'anon') = '42501',
  'anon não dispara o drain de email');

-- a `claim_emails` nasce na 0015, que vive em outro PR: enquanto ela não
-- existir aqui, a asserção se cala em vez de reprovar por função ausente
select testes.ok(
  case when to_regprocedure('public.claim_emails(int)') is null then true
       else testes.como('11111111-1111-1111-1111-111111111111',
              $$select public.claim_emails(10)$$) = '42501' end,
  'aluno logado não faz claim da fila de email');

select testes.ok(
  testes.como(null, $$select public.username_disponivel('qualquer')$$, 'anon') = '42501',
  'anon não enumera username');

-- ---------------------------------------------------------------------------
-- 5. config só entrega as chaves públicas
-- ---------------------------------------------------------------------------

insert into public.config (key, value) values ('segredo_de_operacao', '"não deve vazar"'::jsonb);

select testes.ok(
  testes.conta_como(
    $$select count(*)::int from public.config where key = 'segredo_de_operacao'$$) = 0,
  'anon não lê chave de config fora da lista');

insert into public.config (key, value) values ('ultima_captura', '{"em":"agora"}'::jsonb)
  on conflict (key) do nothing;

select testes.ok(
  testes.conta_como(
    $$select count(*)::int from public.config where key = 'ultima_captura'$$) = 1,
  'anon continua lendo a marca de frescor');

-- ---------------------------------------------------------------------------
-- 6. quotas por aluno (0016)
-- ---------------------------------------------------------------------------

insert into public.materias (aluno_id, dia, turma, disciplina, codigo)
select '11111111-1111-1111-1111-111111111111', (i % 6) + 1, '3 E.COMP', 'D' || i, 'C' || i
  from generate_series(1, 40) i;

select testes.ok(
  testes.como('11111111-1111-1111-1111-111111111111',
    $$insert into public.materias (aluno_id, dia, turma, disciplina, codigo)
      values (auth.uid(), 2, '3 E.COMP', 'A MAIS', 'XX41')$$) = 'P0001',
  'a 41ª matéria é recusada');

-- o motivo de o trigger ser AFTER: num POST único com array, o BEFORE não
-- enxerga as irmãs da mesma instrução e o lote inteiro entraria
select testes.ok(
  testes.como('33333333-3333-3333-3333-333333333333',
    $$insert into public.materias (aluno_id, dia, turma, disciplina, codigo)
      select '33333333-3333-3333-3333-333333333333', (i % 6) + 1, 'T', 'D' || i, 'Z' || i
        from generate_series(1, 300) i$$) = 'P0001',
  'insert de 300 matérias numa instrução só não passa');

insert into public.reclamacoes (aluno_id, descricao)
select '11111111-1111-1111-1111-111111111111', 'reclamação ' || i from generate_series(1, 10) i;

select testes.ok(
  testes.como('11111111-1111-1111-1111-111111111111',
    $$insert into public.reclamacoes (aluno_id, descricao) values (auth.uid(), 'mais uma')$$)
    = 'P0001',
  'a 11ª reclamação aberta é recusada');

update public.reclamacoes set resolvido_em = now()
 where aluno_id = '11111111-1111-1111-1111-111111111111';

select testes.ok(
  testes.como('11111111-1111-1111-1111-111111111111',
    $$insert into public.reclamacoes (aluno_id, descricao) values (auth.uid(), 'depois de resolver')$$)
    is null,
  'reclamação resolvida libera vaga na fila');

-- 0021: a quota conta aberta, então nascer resolvida era o furo
select testes.ok(
  testes.como('11111111-1111-1111-1111-111111111111',
    $$insert into public.reclamacoes (aluno_id, descricao, resolvido_em)
      values (auth.uid(), 'fura fila', 'infinity')$$) = '42501',
  'aluno não cria reclamação já resolvida');

select testes.ok(
  testes.como('11111111-1111-1111-1111-111111111111',
    $$insert into public.reclamacoes (aluno_id, descricao, criado)
      values (auth.uid(), 'fura ordem', now() - interval '1 year')$$) = '42501',
  'aluno não forja a data da reclamação');

select testes.ok(
  testes.como('11111111-1111-1111-1111-111111111111',
    $$insert into public.reclamacoes (aluno_id, descricao)
      values (auth.uid(), repeat('x', 501))$$) = '23514',
  'descrição acima de 500 caracteres é recusada');

insert into public.push_subscriptions (endpoint, aluno_id, p256dh, auth)
select 'https://fcm.googleapis.com/fcm/send/' || i, '11111111-1111-1111-1111-111111111111', 'p', 'a'
  from generate_series(1, 10) i;

select testes.ok(
  testes.como('11111111-1111-1111-1111-111111111111',
    $$insert into public.push_subscriptions (endpoint, aluno_id, p256dh, auth)
      values ('https://fcm.googleapis.com/fcm/send/11', auth.uid(), 'p', 'a')$$) = 'P0001',
  'o 11º aparelho é recusado');

select testes.ok(
  testes.como('11111111-1111-1111-1111-111111111111',
    $$insert into public.push_subscriptions (endpoint, aluno_id, p256dh, auth)
      values ('https://fcm.googleapis.com/fcm/send/3', auth.uid(), 'p2', 'a2')
      on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth$$)
    is null,
  'renovar inscrição que já existe continua passando no limite');

-- ---------------------------------------------------------------------------
-- 6b. endpoint de push só em push service conhecido (0020)
-- ---------------------------------------------------------------------------
-- o aluno 2 está bloqueado e o 1 já está no teto: o admin é quem tem vaga

select testes.ok(
  testes.como('33333333-3333-3333-3333-333333333333',
    $$insert into public.push_subscriptions (endpoint, aluno_id, p256dh, auth)
      values ('https://127.0.0.1:5432/', auth.uid(), 'p', 'a')$$) = '23514',
  'endpoint na rede interna é recusado');

select testes.ok(
  testes.como('33333333-3333-3333-3333-333333333333',
    $$insert into public.push_subscriptions (endpoint, aluno_id, p256dh, auth)
      values ('https://fcm.googleapis.com.atacante.com/x', auth.uid(), 'p', 'a')$$) = '23514',
  'host que só começa igual ao FCM é recusado');

select testes.ok(
  testes.como('33333333-3333-3333-3333-333333333333',
    $$insert into public.push_subscriptions (endpoint, aluno_id, p256dh, auth)
      values ('https://web.push.apple.com/abc', auth.uid(), repeat('p', 500), 'a')$$) = '23514',
  'chave p256dh gigante é recusada');

select testes.ok(
  testes.como('33333333-3333-3333-3333-333333333333',
    $$insert into public.push_subscriptions (endpoint, aluno_id, p256dh, auth)
      values ('https://web.push.apple.com/abc', auth.uid(), 'p', 'a')$$) is null,
  'inscrição do iPhone continua entrando');

-- ---------------------------------------------------------------------------
-- 7. escrita nas tabelas de captura
-- ---------------------------------------------------------------------------

select testes.ok(
  testes.como('11111111-1111-1111-1111-111111111111',
    $$insert into public.mapa_dia (data, categoria, sala)
      values (current_date, 'GRADUAÇÃO - MANHÃ', '999')$$) in ('42501'),
  'aluno não escreve no mapa do dia');

select testes.ok(
  testes.como('11111111-1111-1111-1111-111111111111',
    $$delete from public.alunos where id = auth.uid()$$) = '42501',
  'exclusão de conta continua sendo só pela edge function');

-- 0023: email que esgotou as tentativas também sai depois de 30 dias
select testes.ok(
  (select count(*) = 1 and bool_and(command like '%tentativas >= 5%')
     from cron.job where jobname = 'email-queue-retencao'),
  'retenção da fila apaga também o email que nunca saiu, num job só');

rollback;
