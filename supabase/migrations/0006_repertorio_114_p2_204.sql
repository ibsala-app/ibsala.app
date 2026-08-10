-- ibsala v5 — três grafias que a quarentena (e a regra da barra) pegaram
--
-- Conferido em 10/08, no pré-flight do cutover:
--
--   1. `salas_pendentes` tinha 2 linhas desde 07/08:
--      '109 (P2) MAKER'        -> rótulo curto do maker, a sala já existe (P2-109)
--      '204 (P2) LAB MAQUETES' -> sala NOVA, não aparecia em quatro meses de
--                                 captura, então não entrou na revisão de 06/08
--
--   2. '114 LAB QUIMICA/FISICA' nem chegou na quarentena: a regra da barra
--      rodava ANTES do repertório e engolia a grafia como se fosse par
--      concatenado. Efeito em produção nos dois sistemas: a 114 aparecia LIVRE
--      com aula dentro (10/08 tinha FLUÍDOS 09:50 e FÍSICA DO MOVIMENTO 13:30).
--      A ordem foi invertida em `capture/captura.py`: grafia cadastrada ganha
--      da barra; grafia desconhecida com barra continua ignorada.
--
-- O JSON do repertório é a fonte; esta migration só espelha no banco.

-- ---------------------------------------------------------------------------
-- 1. sala nova
-- ---------------------------------------------------------------------------

insert into public.salas (sala, predio) values ('P2-204', 'P2')
on conflict (sala) do update set predio = excluded.predio, ativa = true;

-- ---------------------------------------------------------------------------
-- 2. backfill das três grafias
--
-- Sem isto a linha só resolve na próxima captura, e o histórico fica com a
-- sala livre num horário em que ela estava ocupada.
-- ---------------------------------------------------------------------------

with alias (bruta, canon) as (values
  ('109 (P2) MAKER', 'P2-109'),
  ('204 (P2) LAB MAQUETES', 'P2-204'),
  ('114 LAB QUIMICA/FISICA', '114')
)
update public.mapa_dia m
   set sala_canon = a.canon
  from alias a
 where btrim(m.sala) = a.bruta
   and m.sala_canon is null;

-- ---------------------------------------------------------------------------
-- 3. limpa a quarentena do que virou repertório
-- ---------------------------------------------------------------------------

delete from public.salas_pendentes
where alias in ('109 (P2) MAKER', '204 (P2) LAB MAQUETES');
