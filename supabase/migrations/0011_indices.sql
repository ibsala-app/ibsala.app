-- ibsala v5 — índices que faltavam e um que ninguém usa
--
-- Levantado junto com o conserto do mapa fantasma (captura passa a apagar o que
-- a planilha não tem mais).

-- o push-slot busca `materias?dia=eq.N` a cada disparo (6 por dia útil) e só
-- existia índice por aluno_id, então era seq scan
create index if not exists materias_dia_idx on public.materias (dia);

-- o drain roda a cada 5 min com `enviado=eq.false&tentativas=lt.5` e a fila não
-- tinha índice nenhum além da PK. Parcial porque só a fila pendente é buscada
create index if not exists email_queue_pendente_idx
  on public.email_queue (id) where not enviado;

-- ninguém filtra mapa_dia por código no servidor: o app e o push-slot baixam o
-- dia inteiro e recortam no cliente. Quem serve essas duas queries é o índice da
-- unique (data, merge_key). Índice sem leitor é escrita a cada upsert por nada
drop index if exists public.mapa_dia_codigo_idx;
