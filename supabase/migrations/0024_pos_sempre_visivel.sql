-- ibsala v5: a pós aparece inteira, qualquer que seja a data da planilha
--
-- A 0019 só mandava o lote da pós quando a data escrita na planilha era hoje:
-- planilha parada em outra data era tratada como desatualizada e sumia da tela.
-- Em 24/09 o Josh decidiu o contrário: o app mostra sempre tudo o que a planilha
-- da pós tem, e a tela diz de que dia ela é quando não for de hoje. Esconder
-- deixava o aluno sem saber se a pós não tinha aula ou se a fonte estava parada.
--
-- `mapa_pos` guarda UM lote (a troca da 0019 apaga o anterior na mesma
-- transação), então tirar o filtro de data manda exatamente o que a planilha
-- dizia na última captura boa. `data_fonte` vai junto em cada linha para a tela
-- rotular. A marca passa a olhar o lote inteiro, senão a virada do dia não
-- mudaria nada nela e o cliente seguiria com o rótulo de ontem.
--
-- Continua valendo: a pós não entra na conta de salas livres.
--
-- Rollback: `create or replace` da `estado_publico` com o corpo da 0019.

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
    '|' || coalesce((select max(p.batch_id::text) from public.mapa_pos p), '') ||
    '|' || (select count(*) from public.mapa_pos p)::text
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
        'horario', p.horario, 'modalidade', p.modalidade,
        'data_fonte', p.data_fonte)
        order by p.id)
        from public.mapa_pos p), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.estado_publico(text) from public;
grant execute on function public.estado_publico(text) to anon, authenticated;
