-- ibsala v5 — atributos de sala e repertório por número de porta
--
-- Em 01/10/2026 o Josh fotografou a placa de cada porta do prédio principal e do
-- P2 (83 salas) e classificou uma a uma. Duas mudanças saem disso:
--
-- 1. A canônica passa a ser o NÚMERO da porta. Os códigos que a planilha usa
--    (2A1, 2L2, 3L1, HUBS...) eram canônicas próprias e por isso a mesma porta
--    aparecia duas vezes na lista de livres: "207" e "2L2" lado a lado. Agora
--    são apelidos em `salas-repertorio.json`.
--
-- 2. `salas` ganha os atributos do levantamento. O que manda no app é a
--    `modalidade`: só `aula` e `estudo` entram na lista de livres.
--      aula     recebe aula e fica livre quando não tem
--      so_aula  recebe aula, nunca aparece livre (laboratório de uso controlado)
--      estudo   nunca recebe aula, sempre livre (sala de estudos, biblioteca)
--      fechada  sem acesso de aluno (secretaria, área técnica, coordenação)
--
-- Fonte: projetos/ibsala/ibsala-placas-2026-10-01.md no Cérebro.

alter table public.salas
  add column if not exists andar      smallint,
  add column if not exists codinome   text,
  add column if not exists formato    text not null default 'normal',
  add column if not exists curso      text,
  add column if not exists modalidade text not null default 'aula';

alter table public.salas
  add constraint salas_formato_ck
    check (formato in ('normal', 'lab', 'anfiteatro', 'hibrida')),
  add constraint salas_curso_ck
    check (curso is null or curso in ('tech', 'arquitetura', 'economia', 'direito')),
  add constraint salas_modalidade_ck
    check (modalidade in ('aula', 'so_aula', 'estudo', 'fechada'));

insert into public.salas (sala, predio, andar, codinome, formato, curso, modalidade) values
  ('101', 'P1', 1, 'Sala de Estudos', 'normal', null, 'estudo'),
  ('102', 'P1', 1, '1L1', 'lab', null, 'aula'),
  ('103', 'P1', 1, 'Design Thinking', 'normal', null, 'aula'),
  ('104', 'P1', 1, null, 'normal', null, 'aula'),
  ('105', 'P1', 1, 'Trade', 'normal', 'economia', 'aula'),
  ('106', 'P1', 1, null, 'normal', null, 'aula'),
  ('107', 'P1', 1, null, 'normal', null, 'aula'),
  ('108', 'P1', 1, 'Lab Tech', 'normal', 'tech', 'aula'),
  ('109', 'P1', 1, null, 'normal', null, 'aula'),
  ('110', 'P1', 1, null, 'normal', null, 'aula'),
  ('111', 'P1', 1, null, 'normal', null, 'aula'),
  ('112', 'P1', 1, null, 'normal', null, 'aula'),
  ('113', 'P1', 1, 'Pranchetas', 'normal', 'arquitetura', 'aula'),
  ('114', 'P1', 1, 'Lab Química e Física', 'lab', null, 'so_aula'),
  ('115', 'P1', 1, 'Lab de Arquitetura', 'lab', 'arquitetura', 'aula'),
  ('116', 'P1', 1, 'Camarim do Auditório', 'normal', null, 'fechada'),
  ('117', 'P1', 1, 'Secretaria', 'normal', null, 'fechada'),
  ('118', 'P1', 1, 'Área Técnica 1', 'normal', null, 'fechada'),
  ('119', 'P1', 1, 'Biblioteca', 'normal', null, 'estudo'),
  ('201', 'P1', 2, null, 'normal', null, 'aula'),
  ('202', 'P1', 2, null, 'normal', null, 'aula'),
  ('203', 'P1', 2, null, 'normal', null, 'aula'),
  ('204', 'P1', 2, 'Lab Arq', 'normal', 'arquitetura', 'aula'),
  ('205', 'P1', 2, null, 'normal', null, 'aula'),
  ('206', 'P1', 2, null, 'normal', null, 'aula'),
  ('207', 'P1', 2, '2L2', 'lab', null, 'aula'),
  ('208', 'P1', 2, null, 'normal', null, 'aula'),
  ('209', 'P1', 2, 'Sala Professores', 'normal', null, 'fechada'),
  ('210', 'P1', 2, null, 'normal', null, 'aula'),
  ('211', 'P1', 2, null, 'normal', null, 'aula'),
  ('212', 'P1', 2, 'Híbrida', 'hibrida', null, 'aula'),
  ('213', 'P1', 2, null, 'normal', null, 'aula'),
  ('214', 'P1', 2, 'Anfiteatro 2A3', 'anfiteatro', null, 'aula'),
  ('215', 'P1', 2, 'Anfiteatro 2A2', 'anfiteatro', null, 'aula'),
  ('216', 'P1', 2, 'Anfiteatro 2A1', 'anfiteatro', null, 'aula'),
  ('217', 'P1', 2, '2L1', 'lab', null, 'aula'),
  ('218', 'P1', 2, 'Apoio TI', 'normal', null, 'fechada'),
  ('219', 'P1', 2, 'Área Técnica 2', 'normal', null, 'fechada'),
  ('220', 'P1', 2, 'Coord Pós-Graduação', 'normal', null, 'fechada'),
  ('221', 'P1', 2, 'RH', 'normal', null, 'fechada'),
  ('222', 'P1', 2, 'Solcorp', 'normal', null, 'fechada'),
  ('223', 'P1', 2, 'Professores TI', 'normal', null, 'fechada'),
  ('224', 'P1', 2, 'High School / Marketing / Operações', 'normal', null, 'fechada'),
  ('301', 'P1', 3, null, 'normal', null, 'aula'),
  ('302', 'P1', 3, null, 'normal', null, 'aula'),
  ('303', 'P1', 3, null, 'normal', null, 'aula'),
  ('304', 'P1', 3, null, 'normal', null, 'aula'),
  ('305', 'P1', 3, null, 'normal', null, 'aula'),
  ('306', 'P1', 3, null, 'normal', null, 'aula'),
  ('307', 'P1', 3, '3L2', 'lab', null, 'aula'),
  ('308', 'P1', 3, 'Lab Tech', 'normal', 'tech', 'aula'),
  ('309', 'P1', 3, null, 'normal', null, 'aula'),
  ('310', 'P1', 3, null, 'normal', null, 'aula'),
  ('311', 'P1', 3, null, 'normal', null, 'aula'),
  ('312', 'P1', 3, null, 'normal', null, 'aula'),
  ('313', 'P1', 3, null, 'normal', null, 'aula'),
  ('314', 'P1', 3, null, 'normal', null, 'aula'),
  ('315', 'P1', 3, '3L1', 'lab', null, 'aula'),
  ('317', 'P1', 3, 'Apoio ao Aluno (CASA)', 'normal', null, 'fechada'),
  ('318', 'P1', 3, 'Carreiras', 'normal', null, 'fechada'),
  ('319', 'P1', 3, 'NDE/CPA', 'normal', null, 'fechada'),
  ('320', 'P1', 3, 'Área Técnica 3', 'normal', null, 'fechada'),
  ('321', 'P1', 3, 'Reitoria', 'normal', null, 'fechada'),
  ('322', 'P1', 3, 'Atendimento Coordenação', 'normal', null, 'fechada'),
  ('323', 'P1', 3, 'Coord. Graduação / Pró-Reitoria Acadêmica', 'normal', null, 'fechada'),
  ('324', 'P1', 3, 'Suporte Infra', 'normal', null, 'fechada'),
  ('P2-101', 'P2', 1, 'Lab Construção Civil', 'lab', 'arquitetura', 'aula'),
  ('P2-102', 'P2', 1, null, 'normal', null, 'aula'),
  ('P2-103', 'P2', 1, 'Plenária NPJ', 'normal', 'direito', 'aula'),
  ('P2-104', 'P2', 1, 'NPJ', 'normal', 'direito', 'aula'),
  ('P2-105', 'P2', 1, 'Almoxarifado', 'normal', null, 'fechada'),
  ('P2-106', 'P2', 1, null, 'normal', null, 'aula'),
  ('P2-107', 'P2', 1, 'Lab Metrologia', 'lab', null, 'so_aula'),
  ('P2-108', 'P2', 1, 'Lab Hidráulica e Pneumática', 'lab', null, 'so_aula'),
  ('P2-109', 'P2', 1, 'Lab Maker', 'lab', null, 'aula'),
  ('P2-201', 'P2', 2, 'Professores TI', 'normal', null, 'fechada'),
  ('P2-202', 'P2', 2, 'Lab Redes', 'lab', 'tech', 'so_aula'),
  ('P2-203', 'P2', 2, null, 'lab', 'tech', 'so_aula'),
  ('P2-204', 'P2', 2, 'Maquetes', 'lab', 'arquitetura', 'so_aula'),
  ('P2-205', 'P2', 2, 'CEI Hubs', 'normal', null, 'fechada'),
  ('P2-206', 'P2', 2, null, 'normal', null, 'aula'),
  ('P2-207', 'P2', 2, 'Lab Projetos Elétricos', 'lab', null, 'so_aula'),
  ('P2-208', 'P2', 2, 'Ibmex', 'normal', null, 'fechada')
on conflict (sala) do update set
  predio = excluded.predio, andar = excluded.andar, codinome = excluded.codinome,
  formato = excluded.formato, curso = excluded.curso,
  modalidade = excluded.modalidade, ativa = true;

-- Os códigos viram apelido. `ativa = false` e não DELETE: até a `captura` nova
-- subir, a versão no ar continua fazendo upsert de (sala, predio) com o JSON
-- velho, e uma linha apagada voltaria com `ativa` no default true.
update public.salas set ativa = false
 where sala in ('2A1', '2A2', '2A3', '2L1', '2L2', '3L1', '3L2', 'P2-HUBS');

-- O histórico passa a apontar pra porta, senão a busca por sala e o push
-- continuam vendo "2L2" onde agora existe "207".
with codigo (velho, novo) as (values
  ('2A1', '216'), ('2A2', '215'), ('2A3', '214'), ('2L1', '217'), ('2L2', '207'),
  ('3L1', '315'), ('3L2', '307'), ('P2-HUBS', 'P2-205')
)
update public.mapa_dia m
   set sala_canon = c.novo
  from codigo c
 where m.sala_canon = c.velho;

with codigo (velho, novo) as (values
  ('2A1', '216'), ('2A2', '215'), ('2A3', '214'), ('2L1', '217'), ('2L2', '207'),
  ('3L1', '315'), ('3L2', '307'), ('P2-HUBS', 'P2-205')
)
update public.mapa_pos m
   set sala_canon = c.novo
  from codigo c
 where m.sala_canon = c.velho;

-- A RPC de abertura passa a mandar os atributos. Os atributos entram no hash
-- porque reclassificar uma sala não mexe em sala nem em prédio, e sem isso o
-- app continuaria com a classificação velha até a próxima captura.
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
    '|' || coalesce((select md5(string_agg(
                         s.sala || s.predio || s.modalidade || coalesce(s.curso, '') ||
                         coalesce(s.codinome, ''), ',' order by s.sala))
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
