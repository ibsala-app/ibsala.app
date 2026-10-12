-- Grafias históricas com número de porta explícito, conferidas nas placas de
-- 01/10. Não cria salas. Reunião 2 é ignorada a pedido do Josh em 12/10.
with alias (bruta, canon) as (values
  ('106 (prédio 2)', 'P2-106'),
  ('101 (P2) LAB MATERIAIS DE CONSTRUÇÃO', 'P2-101'),
  ('101 (P2) LAB.MATERIAS DE CONSTRUÇÃO', 'P2-101'),
  ('LAB. MATERIAIS CONSTRUÇÃO - 101 (P2)', 'P2-101'),
  ('115 LAB ARQ', '115'), ('308 (TECH)', '308'),
  ('207 (P2) LAB.PROJETOS ELETRICOS', 'P2-207')
)
update public.mapa_dia m set sala_canon = a.canon from alias a
where lower(btrim(m.sala)) = lower(a.bruta) and m.sala_canon is null;

with alias (bruta, canon) as (values
  ('106 (prédio 2)', 'P2-106'),
  ('101 (P2) LAB MATERIAIS DE CONSTRUÇÃO', 'P2-101'),
  ('101 (P2) LAB.MATERIAS DE CONSTRUÇÃO', 'P2-101'),
  ('LAB. MATERIAIS CONSTRUÇÃO - 101 (P2)', 'P2-101'),
  ('115 LAB ARQ', '115'), ('308 (TECH)', '308'),
  ('207 (P2) LAB.PROJETOS ELETRICOS', 'P2-207')
)
update public.mapa_pos m set sala_canon = a.canon from alias a
where lower(btrim(m.sala_raw)) = lower(a.bruta) and m.sala_canon is null;

delete from public.salas_pendentes where lower(btrim(alias)) in (
  lower('106 (prédio 2)'), lower('101 (P2) LAB MATERIAIS DE CONSTRUÇÃO'),
  lower('101 (P2) LAB.MATERIAS DE CONSTRUÇÃO'),
  lower('LAB. MATERIAIS CONSTRUÇÃO - 101 (P2)'), lower('115 LAB ARQ'),
  lower('308 (TECH)'), lower('207 (P2) LAB.PROJETOS ELETRICOS'),
  lower('CANCELADO'), lower('SALA DE REUNIÃO 2')
);
