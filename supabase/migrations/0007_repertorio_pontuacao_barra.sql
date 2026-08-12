-- ibsala v5 — o defeito da 114 voltou, com outra pontuação
--
-- Achado em 12/08, checando adoção pós-cutover:
--
--   1. A planilha passou a escrever '103 (DESIGN THINKING)'. O repertório tinha
--      '103 - DESIGN THINKING', e a chave de casamento normalizava acento e
--      espaço, não pontuação: a grafia caía na quarentena, `sala_canon` ficava
--      nulo e a 103 aparecia LIVRE das 11h às 18h com evento dentro. Mesmo
--      defeito da 114 em 10/08, um caractere diferente.
--      Conserto em `capture/captura.py`: a chave ignora parêntese, hífen e
--      ponto (a barra sobrevive, a regra dela depende disso), e o load agora
--      morre se dois rótulos colapsarem na mesma chave apontando pra salas
--      diferentes.
--
--   2. '207 (P2) LAB.PROJETOS ELETRICOS/206 (P2)' (Arquitetura de Computadores,
--      15:50/17:40) batia na regra da barra, que descartava o rótulo inteiro
--      sem ver que o lado DIREITO é apelido cadastrado: a P2-206 aparecia livre
--      com aula dentro. Agora, rótulo com barra em que só UM lado resolve ocupa
--      esse lado. Com dois lados válidos ('302/303') o comportamento de 06/08
--      não muda (não ocupa nada), mas o caso passa a ser logado pra decidir com
--      volume medido.
--
--   3. 'AUDITÓRIO' e 'FOYER' estavam na quarentena desde 10/08 sem virar
--      decisão: recebem evento, não são sala das 59. Entraram em `ignoradas`.
--
-- ATENÇÃO, pendência de decisão humana: o lado esquerdo daquele rótulo,
-- '207 (P2) LAB.PROJETOS ELETRICOS', NÃO existe no repertório. Se P2-207 for
-- sala de verdade, ela precisa nascer no JSON (canônica + apelido), como a
-- P2-204 nasceu em 0006. Até alguém confirmar no prédio, esta migration não
-- inventa a sala.
--
-- O JSON do repertório é a fonte; esta migration só espelha no banco.

-- ---------------------------------------------------------------------------
-- 1. backfill das duas grafias
--
-- Sem isto a linha só resolve na próxima captura, e o histórico do dia fica com
-- a sala livre num horário em que ela estava ocupada.
-- ---------------------------------------------------------------------------

with alias (bruta, canon) as (values
  ('103 (DESIGN THINKING)', '103'),
  ('207 (P2) LAB.PROJETOS ELETRICOS/206 (P2)', 'P2-206')
)
update public.mapa_dia m
   set sala_canon = a.canon
  from alias a
 where btrim(m.sala) = a.bruta
   and m.sala_canon is null;

-- ---------------------------------------------------------------------------
-- 2. limpa a quarentena do que virou repertório ou virou ignorada
--
-- Quarentena vazia volta a significar "nada novo na fonte". A captura também
-- passou a mandar `visto_em` no upsert: antes a coluna guardava o PRIMEIRO
-- avistamento pra sempre e não dizia se a grafia ainda aparece hoje.
-- ---------------------------------------------------------------------------

delete from public.salas_pendentes
where alias in ('103 (DESIGN THINKING)', 'AUDITÓRIO', 'FOYER');
