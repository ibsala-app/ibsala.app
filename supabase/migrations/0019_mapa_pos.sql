-- ibsala v5 — a planilha da pós-graduação entra como INFORMAÇÃO, em tabela própria
--
-- A coordenação da pós mantém um mapa de salas separado do da graduação
-- (planilha `1FVjxFLKgUC2U8GX2X3vgOeoDPt1Kx0wvOZHDgQk8KXk`, aba "Pós
-- Graduação"). Inspecionada em 27/08: cabeçalho SALA, CURSO, uma coluna sem
-- nome, DISCIPLINA e PROFESSOR(A), a data escrita por extenso na A4, e
-- NENHUMA COLUNA DE HORÁRIO.
--
-- Sem horário, uma linha não consegue dizer em qual dos seis slots a sala está
-- ocupada, e chutar isso tiraria sala da lista de livres com base em suposição.
-- Por decisão do Josh em 27/08, esta fase é só informativa: `afeta_ocupacao`
-- nasce `false` e o cálculo de salas livres continua saindo apenas de
-- `mapa_dia`. As colunas `horario` e `afeta_ocupacao` já existem para a fase
-- seguinte não precisar de migration destrutiva.
--
-- POR QUE TABELA SEPARADA, e não uma coluna `origem` no `mapa_dia`:
-- a limpeza da captura (`apagarFantasmas`, captura/index.ts) apaga por DIA e
-- por `capturado`, sem filtro de origem. Com a pós dentro do `mapa_dia`, a
-- captura da graduação apagaria a pós a cada 20 minutos, e a captura da pós
-- apagaria a graduação. Em tabelas separadas isso é impossível por construção,
-- não por disciplina de quem escreve a query.
--
-- Rollback: `drop table public.mapa_pos cascade`, `drop function
-- public.substituir_lote_pos(jsonb, date, uuid)`, `create or replace` da
-- `estado_publico` com o corpo da 0018 e `cron.unschedule('captura-pos')`.

create table public.mapa_pos (
  id            bigint generated always as identity primary key,
  -- a data ESCRITA na planilha (célula A4), nunca a data do servidor: em 27/08
  -- a fonte ainda dizia 25/08, e trocar em silêncio seria inventar aula
  data_fonte    date not null,
  capturado_em  timestamptz not null default now(),
  batch_id      uuid not null,
  origem        text not null default 'pos' check (origem = 'pos'),
  sala_raw      text,
  sala_canon    text,
  curso         text,
  -- a coluna sem cabeçalho da planilha (valor visto: "20251B"). Guardada crua e
  -- sem interpretação: turma, período e coorte são palpites diferentes, e
  -- ninguém da pós confirmou qual é
  coluna_c_raw  text,
  disciplina    text,
  professor     text,
  horario       text,
  modalidade    text,
  afeta_ocupacao boolean not null default false
);

create index mapa_pos_data_idx on public.mapa_pos (data_fonte);

alter table public.mapa_pos enable row level security;
create policy mapa_pos_read on public.mapa_pos for select using (true);
revoke insert, update, delete on public.mapa_pos from anon, authenticated;

-- ---------------------------------------------------------------------------
-- troca de lote, numa transação
-- ---------------------------------------------------------------------------
-- A tabela guarda UM lote: o que a planilha diz agora. Insere o novo e só então
-- apaga o que não é dele, dentro da mesma transação, para nunca existir um
-- instante em que a pós está vazia na tela de alguém (foi assim que o mapa da
-- graduação já apareceu vazio em produção).
--
-- Planilha estruturalmente válida e VAZIA é um estado legítimo (dia sem aula na
-- pós), e aí o lote novo é vazio e a limpeza acontece. Quem garante que isso só
-- ocorre com fonte válida é a edge function: ela valida cabeçalho e data ANTES
-- de chamar esta RPC, e em qualquer estado degradado nem chega aqui.

create or replace function public.substituir_lote_pos(
  linhas jsonb, p_data date, p_batch uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  inseridas int := 0;
  apagadas  int := 0;
begin
  if p_data is null or p_batch is null then
    raise exception 'lote da pós exige data da fonte e batch' using errcode = '22004';
  end if;

  insert into public.mapa_pos (
    data_fonte, batch_id, sala_raw, sala_canon, curso, coluna_c_raw,
    disciplina, professor, horario, modalidade, afeta_ocupacao)
  select p_data, p_batch,
         l ->> 'sala_raw', l ->> 'sala_canon', l ->> 'curso', l ->> 'coluna_c_raw',
         l ->> 'disciplina', l ->> 'professor', l ->> 'horario', l ->> 'modalidade',
         coalesce((l ->> 'afeta_ocupacao')::boolean, false)
    from jsonb_array_elements(coalesce(linhas, '[]'::jsonb)) l;
  get diagnostics inseridas = row_count;

  delete from public.mapa_pos where batch_id is distinct from p_batch;
  get diagnostics apagadas = row_count;

  return jsonb_build_object('inseridas', inseridas, 'apagadas', apagadas);
end;
$$;

revoke all on function public.substituir_lote_pos(jsonb, date, uuid)
  from public, anon, authenticated;
grant execute on function public.substituir_lote_pos(jsonb, date, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- a marca de frescor da pós vira chave pública de config
-- ---------------------------------------------------------------------------
-- Mesmo papel de `ultima_captura`: sem ela, agendador parado é invisível.

drop policy if exists config_read on public.config;
create policy config_read on public.config
  for select using (key in ('travado', 'ultima_captura', 'ultimo_email_drain',
                            'ultima_captura_pos'));

-- ---------------------------------------------------------------------------
-- estado público passa a levar a pós junto
-- ---------------------------------------------------------------------------
-- Só entra o que for do dia de hoje. Planilha com data velha (o caso real de
-- 27/08, com a fonte parada em 25/08) não aparece no app: por decisão do Josh,
-- data diferente de hoje significa planilha desatualizada, e não "aula de hoje".
-- O lote antigo continua no banco, porque ele é a prova do que a fonte dizia.

create or replace function public.estado_publico(marca text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  dia    date := (now() at time zone 'America/Sao_Paulo')::date;
  agora  text;
  base   jsonb;
begin
  -- `max(capturado)` sozinho não basta: a captura também APAGA linha que a
  -- planilha não tem mais (o fantasma de 12/08), e isso não mexe no máximo.
  -- A contagem entra junto, as salas ativas entram inteiras porque mudança de
  -- prédio no repertório não mexe em nenhum dos dois, e o lote da pós entra
  -- pelo batch, que muda a cada captura que troca conteúdo.
  select md5(
    coalesce((select max(m.capturado)::text from public.mapa_dia m where m.data = dia), '') ||
    '|' || (select count(*) from public.mapa_dia m where m.data = dia)::text ||
    '|' || coalesce((select md5(string_agg(s.sala || s.predio, ',' order by s.sala))
                       from public.salas s where s.ativa), '') ||
    -- `max(uuid)` não existe no Postgres: o cast vem ANTES do agregado
    '|' || coalesce((select max(p.batch_id::text) from public.mapa_pos p
                      where p.data_fonte = dia), '') ||
    '|' || (select count(*) from public.mapa_pos p where p.data_fonte = dia)::text
  ) into agora;

  base := jsonb_build_object(
    'dia', dia,
    'marca', agora,
    'config', coalesce((
      select jsonb_agg(jsonb_build_object('key', c.key, 'value', c.value))
        from public.config c
       where c.key in ('travado', 'ultima_captura', 'ultimo_email_drain',
                       'ultima_captura_pos')), '[]'::jsonb),
    'total', public.total_alunos()
  );

  if marca is not null and marca = agora then
    return base || jsonb_build_object('mudou', false);
  end if;

  return base || jsonb_build_object(
    'mudou', true,
    'mapa', coalesce((
      select jsonb_agg(jsonb_build_object(
        'turma', m.turma, 'codigo', m.codigo, 'disciplina', m.disciplina,
        'horario', m.horario, 'professor', m.professor,
        'sala', m.sala, 'sala_canon', m.sala_canon))
        from public.mapa_dia m where m.data = dia), '[]'::jsonb),
    'salas', coalesce((
      select jsonb_agg(jsonb_build_object('sala', s.sala, 'predio', s.predio) order by s.sala)
        from public.salas s where s.ativa), '[]'::jsonb),
    'pos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sala', coalesce(p.sala_canon, p.sala_raw), 'sala_canon', p.sala_canon,
        'curso', p.curso, 'disciplina', p.disciplina, 'professor', p.professor,
        'horario', p.horario, 'modalidade', p.modalidade)
        order by p.id)
        from public.mapa_pos p where p.data_fonte = dia), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.estado_publico(text) from public;
grant execute on function public.estado_publico(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- agendamento
-- ---------------------------------------------------------------------------
-- Pré-requisito, uma vez e fora do repo:
--   supabase functions deploy captura-pos --no-verify-jwt
-- Segredos e Vault são os mesmos da captura da graduação.
--
-- Quatro vezes por dia, e não de 20 em 20 minutos como a graduação: a planilha
-- da pós é editada por pessoa, não por sistema, e em 27/08 ela estava parada
-- havia dois dias. Horários em UTC (BRT+3).

create or replace function public.disparar_captura_pos()
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://jbdmkbivmflauushiqca.supabase.co/functions/v1/captura-pos',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
end;
$$;

revoke all on function public.disparar_captura_pos() from public, anon, authenticated;

select cron.schedule('captura-pos', '0 9,12,16,21 * * 1-6',
  $$select public.disparar_captura_pos()$$);
