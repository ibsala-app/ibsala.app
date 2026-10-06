-- Testes da RPC de estado público (0018). Mesmo formato do rls.sql: banco novo,
-- tudo dentro de uma transação que termina em rollback.
--
-- O que precisa continuar verdade aqui: anon consegue chamar, chave de operação
-- não vaza junto, e a marca só muda quando o estado muda de verdade. Se a marca
-- ficar parada com o mapa novo, o aluno vê sala errada; se ela mudar à toa, o
-- app volta a mandar 22 KiB a cada 5 minutos e a economia some.

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

create function testes.como_anon(sql text) returns jsonb
language plpgsql as $$
declare
  r jsonb;
begin
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', 'anon', true);
  execute sql into r;
  perform set_config('role', 'postgres', true);
  return r;
end;
$$;

insert into public.config (key, value) values ('segredo_de_operacao', '"não deve vazar"'::jsonb);

insert into public.mapa_dia (data, categoria, turma, codigo, disciplina, horario, professor, sala, sala_canon)
values (current_date, 'GRADUAÇÃO - MANHÃ', '3 E.COMP', 'BD2', 'BANCO DE DADOS',
        '07:30/09:20', 'Fulano de Tal', '105', 'P1-105');

-- ---------------------------------------------------------------------------

select testes.ok(
  testes.como_anon($$select public.estado_publico()$$) is not null,
  'anon consegue chamar estado_publico');

select testes.ok(
  jsonb_array_length(testes.como_anon($$select public.estado_publico()$$) -> 'mapa') = 1,
  'o mapa do dia vem junto');

select testes.ok(
  (testes.como_anon($$select public.estado_publico()$$) ->> 'dia')::date
    = (now() at time zone 'America/Sao_Paulo')::date,
  'a data é a do servidor em BRT, não a do aparelho');

select testes.ok(
  not exists (
    select 1 from jsonb_array_elements(
      testes.como_anon($$select public.estado_publico()$$) -> 'config') c
     where c ->> 'key' = 'segredo_de_operacao'),
  'chave de operação não vaza no config');

-- marca igual: resposta curta, sem mapa nenhum
do $$
declare
  m text := (select public.estado_publico() ->> 'marca');
  r jsonb;
begin
  select public.estado_publico(m) into r;
  perform testes.ok((r ->> 'mudou') = 'false', 'mandar a marca de volta responde mudou:false');
  perform testes.ok(not (r ? 'mapa'), 'e a resposta curta não carrega o mapa');
  perform testes.ok(r ? 'total' and r ? 'config', 'mas ainda traz config e total');
end;
$$;

-- linha nova no mapa: a marca muda
do $$
declare
  m text := (select public.estado_publico() ->> 'marca');
begin
  insert into public.mapa_dia (data, categoria, turma, codigo, disciplina, horario, professor, sala)
  values (current_date, 'GRADUAÇÃO - TARDE', '5 E.COMP', 'RED5', 'REDES',
          '13:00/15:20', 'Sicrana', '204');
  perform testes.ok((select public.estado_publico(m) ->> 'mudou') = 'true',
    'aula nova no mapa muda a marca');
end;
$$;

-- linha APAGADA também: é o fantasma de 12/08
do $$
declare
  m text := (select public.estado_publico() ->> 'marca');
begin
  delete from public.mapa_dia where codigo = 'RED5';
  perform testes.ok((select public.estado_publico(m) ->> 'mudou') = 'true',
    'aula APAGADA do mapa também muda a marca');
end;
$$;

-- captura que regrava a MESMA planilha não muda nada pro app: só `capturado`
-- anda. Era o defeito da 0025: marca por max(capturado) mudava a cada rodada
do $$
declare
  m text := (select public.estado_publico() ->> 'marca');
begin
  update public.mapa_dia set capturado = now() + interval '20 minutes' where data = current_date;
  perform testes.ok((select public.estado_publico(m) ->> 'mudou') = 'false',
    'captura sem mudança na planilha NÃO muda a marca');
end;
$$;

-- e a troca de sala, que é o que o aluno precisa ver na hora, muda
do $$
declare
  m text := (select public.estado_publico() ->> 'marca');
begin
  update public.mapa_dia set sala = '106', sala_canon = 'P1-106' where codigo = 'BD2';
  perform testes.ok((select public.estado_publico(m) ->> 'mudou') = 'true',
    'troca de sala muda a marca');
end;
$$;

select testes.ok(
  not exists (
    select 1 from jsonb_array_elements(
      testes.como_anon($$select public.estado_publico()$$) -> 'config') c
     where c ->> 'key' not in ('travado', 'ultima_captura')),
  'config pública só leva o que o app lê');

-- repertório de salas entra na marca
do $$
declare
  m text := (select public.estado_publico() ->> 'marca');
begin
  update public.salas set ativa = false where sala = (select min(sala) from public.salas);
  perform testes.ok((select public.estado_publico(m) ->> 'mudou') = 'true',
    'sala desativada muda a marca');
end;
$$;

-- e o que não é estado público não mexe na marca
do $$
declare
  m text := (select public.estado_publico() ->> 'marca');
begin
  insert into public.config (key, value) values ('outra_de_operacao', '"nada"'::jsonb);
  perform testes.ok((select public.estado_publico(m) ->> 'mudou') = 'false',
    'chave de operação nova não invalida o mapa de ninguém');
end;
$$;

rollback;
