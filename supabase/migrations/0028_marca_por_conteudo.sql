-- 0028: a marca do estado público passa a ser do CONTEÚDO, não da hora da captura.
--
-- A marca usava `max(capturado)`. A captura regrava `capturado` em todas as
-- linhas a cada rodada (precisa, é o que deixa o `apagarFantasmas` distinguir
-- linha viva de linha morta), então toda captura mudava a marca, com ou sem
-- mudança na planilha. Nas viradas de horário a captura roda de 2 em 2 minutos
-- (0026) e o app busca de 2 em 2: cada busca baixava o mapa inteiro, e o
-- `mudou: false` que justificava a função nunca acontecia justamente ali. O
-- teste dizia que "a marca só muda quando o estado muda de verdade", e não era
-- o que a captura fazia (auditoria de 06/10/2026).
--
-- Agora entram os campos que o app recebe. Linha nova, linha apagada e sala
-- trocada mudam o hash; regravar a mesma planilha, não. A pós tinha o mesmo
-- defeito pelo `batch_id`, que muda a cada rodada.
--
-- O frescor não se perde: `config.ultima_captura` continua vindo em toda
-- resposta, inclusive na curta, e é dela que a pill sai.
--
-- De carona, o payload de config perde `ultimo_email_drain` e
-- `ultima_captura_pos`: o app nunca leu nenhuma das duas, elas viajavam em toda
-- busca e a primeira expunha a contagem da fila de email pra `anon`.

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
  select md5(
    coalesce((select md5(string_agg(
                         coalesce(m.turma, '') || '|' || coalesce(m.codigo, '') || '|' ||
                         coalesce(m.disciplina, '') || '|' || coalesce(m.horario, '') || '|' ||
                         coalesce(m.professor, '') || '|' || coalesce(m.sala, '') || '|' ||
                         coalesce(m.sala_canon, ''), E'\n' order by m.id))
                       from public.mapa_dia m where m.data = dia), '') ||
    '|' || coalesce((select md5(string_agg(
                         s.sala || s.predio || s.modalidade || coalesce(s.curso, '') ||
                         coalesce(s.codinome, ''), ',' order by s.sala))
                       from public.salas s where s.ativa), '') ||
    '|' || coalesce((select md5(string_agg(
                         coalesce(p.sala_raw, '') || '|' || coalesce(p.sala_canon, '') || '|' ||
                         coalesce(p.curso, '') || '|' || coalesce(p.disciplina, '') || '|' ||
                         coalesce(p.professor, '') || '|' || coalesce(p.horario, '') || '|' ||
                         coalesce(p.modalidade, '') || '|' || coalesce(p.data_fonte::text, ''),
                         E'\n' order by p.id))
                       from public.mapa_pos p), '')
  ) into agora;

  base := jsonb_build_object(
    'dia', dia,
    'marca', agora,
    'config', coalesce((
      select jsonb_agg(jsonb_build_object('key', c.key, 'value', c.value))
        from public.config c
       where c.key in ('travado', 'ultima_captura')), '[]'::jsonb),
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
      select jsonb_agg(jsonb_build_object(
        'sala', s.sala, 'predio', s.predio, 'andar', s.andar, 'codinome', s.codinome,
        'formato', s.formato, 'curso', s.curso, 'modalidade', s.modalidade)
        order by s.sala)
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

-- Entre 00:30 (retenção) e 07:00 a única captura era a das 05:00. Se ela
-- falhasse, o aviso das 06:40 saía com o mapa vazio e ninguém era avisado da
-- primeira aula. 06:20 de Brasília dá uma segunda chance antes do disparo.
select cron.schedule('captura-0620', '20 9 * * 1-5', $$select public.disparar_captura()$$);
