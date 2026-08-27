-- ibsala v5 — o estado público do app numa resposta só, que sabe se mudou
--
-- A abertura do app faz QUATRO requisições (mapa do dia, salas ativas, config e
-- total de alunos) e as repete INTEIRAS a cada 5 minutos. Medido em 27/08 na
-- produção: 20.448 + 1.920 + 459 + 2 = 22.829 bytes por carga. Projetando 1.000
-- alunos com o app aberto durante o turno, são ~48 cargas por aluno por dia e
-- ~20 GiB em 20 dias letivos, contra os 5 GB de egress da cota Free.
--
-- Juntar as quatro numa só economiza pouco (2,7% medidos: o mapa é 90% do
-- payload). O que muda a ordem de grandeza é a segunda parte: o mapa só muda
-- quando a captura escreve, a cada 30 minutos, e mesmo assim quase sempre nas
-- mesmas linhas. Então a função devolve uma MARCA do estado, o app manda a marca
-- que ele já tem, e quando nada mudou a resposta é `mudou: false` com config e
-- total (menos de 600 bytes) em vez de 22 KiB.
--
-- `security definer` porque a leitura de `config` é restrita por policy à lista
-- de chaves públicas (0010). Aqui a lista aparece explícita, no mesmo lugar, em
-- vez de depender de a policy nunca mudar: chave de operação nova NÃO entra por
-- acidente. Nada nesta resposta é pessoal, e é isso que a deixa cacheável no dia
-- em que o firewall do campus obrigar a servir por ibsala.com.br.
--
-- A data sai do servidor, em BRT, e não do relógio do aparelho: celular com fuso
-- errado pedia o mapa de outro dia e via tela vazia sem entender por quê.
--
-- Rollback: `drop function public.estado_publico(text)`. O app volta às quatro
-- consultas sozinho, porque ele já trata a função ausente.

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
  -- A contagem entra junto, e as salas ativas entram inteiras porque mudança de
  -- prédio no repertório não mexe em nenhum dos dois.
  select md5(
    coalesce((select max(m.capturado)::text from public.mapa_dia m where m.data = dia), '') ||
    '|' || (select count(*) from public.mapa_dia m where m.data = dia)::text ||
    '|' || coalesce((select md5(string_agg(s.sala || s.predio, ',' order by s.sala))
                       from public.salas s where s.ativa), '')
  ) into agora;

  base := jsonb_build_object(
    'dia', dia,
    'marca', agora,
    'config', coalesce((
      select jsonb_agg(jsonb_build_object('key', c.key, 'value', c.value))
        from public.config c
       where c.key in ('travado', 'ultima_captura', 'ultimo_email_drain')), '[]'::jsonb),
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
        from public.salas s where s.ativa), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.estado_publico(text) from public;
grant execute on function public.estado_publico(text) to anon, authenticated;
