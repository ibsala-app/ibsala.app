-- Testes da pós (0019): isolamento entre as duas fontes, troca de lote e a
-- regra de data. Banco novo, tudo dentro de uma transação que termina em
-- rollback.
--
-- O que estes testes protegem é o motivo de a pós ter tabela própria: a limpeza
-- de uma captura não pode alcançar as linhas da outra. Em `mapa_dia` isso seria
-- disciplina de quem escreve a query; aqui é impossível por construção, e o
-- teste é a prova.

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

create function testes.como(uid uuid, sql text, papel text default 'authenticated')
returns text
language plpgsql as $$
declare
  estado text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', papel)::text, true);
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

create function testes.conta_anon(sql text) returns int
language plpgsql as $$
declare
  n int;
begin
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', 'anon', true);
  execute sql into n;
  perform set_config('role', 'postgres', true);
  return n;
end;
$$;

-- graduação de hoje, para provar que uma captura não come a outra
insert into public.mapa_dia (data, categoria, turma, codigo, disciplina, horario, professor, sala)
values (current_date, 'GRADUAÇÃO - MANHÃ', '3 E.COMP', 'BD2', 'BANCO DE DADOS',
        '07:30/09:20', 'Fulano', '105');

-- ---------------------------------------------------------------------------
-- 1. troca de lote
-- ---------------------------------------------------------------------------

select public.substituir_lote_pos(
  jsonb_build_array(
    jsonb_build_object('sala_raw','Remoto','sala_canon',null,'curso','LLM',
      'coluna_c_raw','20251B','disciplina','TCC','professor','Pedro',
      'horario',null,'modalidade','remoto'),
    jsonb_build_object('sala_raw','204 (P2) LAB MAQUETES','sala_canon','P2-204',
      'curso','MBA','coluna_c_raw','20251B','disciplina','Projeto','professor','Ana',
      'horario',null,'modalidade','presencial')),
  (now() at time zone 'America/Sao_Paulo')::date,
  '11111111-1111-1111-1111-111111111111');

select testes.ok((select count(*) from public.mapa_pos) = 2, 'lote entra inteiro');
select testes.ok(
  (select count(*) from public.mapa_pos where not afeta_ocupacao) = 2,
  'nenhuma linha da pós nasce ocupando sala');

select public.substituir_lote_pos(
  jsonb_build_array(jsonb_build_object('sala_raw','Remoto','curso','LLM',
    'disciplina','Outra','professor','Pedro','modalidade','remoto')),
  (now() at time zone 'America/Sao_Paulo')::date,
  '22222222-2222-2222-2222-222222222222');

select testes.ok((select count(*) from public.mapa_pos) = 1, 'lote novo substitui o antigo');
select testes.ok(
  (select disciplina from public.mapa_pos) = 'Outra', 'e o que ficou é o lote novo');
select testes.ok(
  (select count(*) from public.mapa_dia) = 1, 'a troca de lote da pós NÃO toca a graduação');

-- ---------------------------------------------------------------------------
-- 2. a limpeza da graduação não alcança a pós
-- ---------------------------------------------------------------------------
-- é o `apagarFantasmas` da captura: apaga por dia e por `capturado`, sem filtro
-- de origem

-- dentro de uma transação `now()` é o instante do BEGIN, então `capturado <
-- now()` não pegaria as linhas criadas aqui. O que importa provar é o efeito:
-- apagar o dia inteiro da graduação não encosta na pós.
delete from public.mapa_dia where data = current_date;
select testes.ok((select count(*) from public.mapa_pos) = 1,
  'apagar o mapa do dia inteiro não apaga a pós');

insert into public.mapa_dia (data, categoria, turma, codigo, disciplina, horario, professor, sala)
values (current_date, 'GRADUAÇÃO - MANHÃ', '3 E.COMP', 'BD2', 'BANCO DE DADOS',
        '07:30/09:20', 'Fulano', '105');

-- ---------------------------------------------------------------------------
-- 3. a regra de data: planilha velha não vira tela
-- ---------------------------------------------------------------------------

select public.substituir_lote_pos(
  jsonb_build_array(jsonb_build_object('sala_raw','Remoto','curso','LLM',
    'disciplina','De anteontem','professor','Pedro','modalidade','remoto')),
  (now() at time zone 'America/Sao_Paulo')::date - 2,
  '33333333-3333-3333-3333-333333333333');

select testes.ok(
  jsonb_array_length(public.estado_publico() -> 'pos') = 0,
  'lote com data velha não aparece no estado público');
select testes.ok(
  (select count(*) from public.mapa_pos) = 1,
  'mas o lote continua guardado, porque é a prova do que a fonte dizia');

select public.substituir_lote_pos(
  jsonb_build_array(jsonb_build_object('sala_raw','Remoto','curso','LLM',
    'disciplina','De hoje','professor','Pedro','modalidade','remoto')),
  (now() at time zone 'America/Sao_Paulo')::date,
  '44444444-4444-4444-4444-444444444444');

select testes.ok(
  jsonb_array_length(public.estado_publico() -> 'pos') = 1,
  'lote de hoje aparece no estado público');

-- ---------------------------------------------------------------------------
-- 4. a pós não mexe em sala livre
-- ---------------------------------------------------------------------------

do $$
declare
  antes int := jsonb_array_length(public.estado_publico() -> 'salas');
begin
  perform public.substituir_lote_pos(
    jsonb_build_array(jsonb_build_object('sala_raw','105','sala_canon','105',
      'curso','MBA','disciplina','Ocupa?','professor','Ana','modalidade','presencial')),
    (now() at time zone 'America/Sao_Paulo')::date,
    '55555555-5555-5555-5555-555555555555');
  perform testes.ok(
    jsonb_array_length(public.estado_publico() -> 'salas') = antes,
    'aula da pós numa sala física não tira a sala da lista');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. a marca enxerga a pós
-- ---------------------------------------------------------------------------

do $$
declare
  m text := (select public.estado_publico() ->> 'marca');
begin
  perform public.substituir_lote_pos('[]'::jsonb,
    (now() at time zone 'America/Sao_Paulo')::date,
    '66666666-6666-6666-6666-666666666666');
  perform testes.ok((select public.estado_publico(m) ->> 'mudou') = 'true',
    'lote novo da pós muda a marca do estado');
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. quem pode o quê
-- ---------------------------------------------------------------------------

select testes.ok(
  testes.conta_anon($$select count(*)::int from public.mapa_pos$$) >= 0,
  'anon lê a pós (a tela é pública)');

select testes.ok(
  testes.como(null,
    $$insert into public.mapa_pos (data_fonte, batch_id, disciplina)
      values (current_date, gen_random_uuid(), 'invadida')$$, 'anon') = '42501',
  'anon não escreve na pós');

select testes.ok(
  testes.como('11111111-1111-1111-1111-111111111111',
    $$select public.substituir_lote_pos('[]'::jsonb, current_date, gen_random_uuid())$$)
    = '42501',
  'aluno logado não troca o lote da pós');

rollback;
