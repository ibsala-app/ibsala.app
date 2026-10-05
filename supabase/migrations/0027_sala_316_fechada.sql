-- ibsala v5 — sala 316 entra como fechada
--
-- A 316 era a única porta que faltou no levantamento de placas de 01/10/2026
-- (3º andar, entre a 315 e a 317). Em 05/10/2026 o Josh fechou a lacuna: ela
-- fica sempre fechada, igual à 117 Secretaria. Sem acesso de aluno: nunca
-- recebe aula e nunca aparece como livre.
--
-- Esta migration roda ANTES do deploy da `captura` com o repertório novo: a
-- function faz upsert de (sala, predio), e uma linha criada por ela nasceria
-- com `modalidade` no default 'aula'.

insert into public.salas (sala, predio, andar, codinome, formato, curso, modalidade) values
  ('316', 'P1', 3, null, 'normal', null, 'fechada')
on conflict (sala) do update set
  predio = excluded.predio, andar = excluded.andar, codinome = excluded.codinome,
  formato = excluded.formato, curso = excluded.curso,
  modalidade = excluded.modalidade, ativa = true;
