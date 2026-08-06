-- ibsala v5 — repertório fixo de salas
--
-- Antes desta migration a tabela `salas` era subproduto do scraper: toda grafia
-- que aparecia na planilha da faculdade virava linha. Resultado em 06/08: 48
-- linhas, das quais 2 eram pseudo-sala (CANCELADA, ONLINE, servidas ao aluno
-- como "sala livre") e 6 eram variante da mesma sala com rótulo colado
-- ("103 - DESIGN THINKING" ocupava a 103 sem tirá-la da lista de livres).
--
-- Agora `salas` é semeada aqui a partir de `salas-repertorio.json` (58 salas,
-- revisadas uma a uma em 06/08/2026). A tradução grafia crua -> canônica mora
-- no mesmo JSON e é aplicada pela captura, que grava `mapa_dia.sala_canon`.
-- Grafia desconhecida não entra mais no repertório: cai em `salas_pendentes`.

-- ---------------------------------------------------------------------------
-- 1. colunas novas
-- ---------------------------------------------------------------------------

alter table public.salas
  add column if not exists ativa boolean not null default true;

-- sala canônica da linha; `sala` continua crua, porque é o que o aluno lê
alter table public.mapa_dia
  add column if not exists sala_canon text;

create index if not exists mapa_dia_sala_canon_idx
  on public.mapa_dia (data, sala_canon);

-- ---------------------------------------------------------------------------
-- 2. quarentena
-- ---------------------------------------------------------------------------

create table if not exists public.salas_pendentes (
  alias       text primary key,
  visto_em    timestamptz not null default now(),
  ocorrencias int not null default 1
);

alter table public.salas_pendentes enable row level security;

create policy salas_pendentes_admin on public.salas_pendentes
  for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 3. semeadura do repertório
-- ---------------------------------------------------------------------------

insert into public.salas (sala, predio) values
  ('101', 'P1'), ('102', 'P1'), ('103', 'P1'), ('104', 'P1'), ('105', 'P1'),
  ('106', 'P1'), ('107', 'P1'), ('108', 'P1'), ('109', 'P1'), ('110', 'P1'),
  ('111', 'P1'), ('112', 'P1'), ('113', 'P1'), ('114', 'P1'),
  ('201', 'P1'), ('202', 'P1'), ('203', 'P1'), ('204', 'P1'), ('205', 'P1'),
  ('206', 'P1'), ('207', 'P1'), ('208', 'P1'), ('209', 'P1'), ('210', 'P1'),
  ('211', 'P1'), ('212', 'P1'), ('213', 'P1'),
  ('2A1', 'P1'), ('2A2', 'P1'), ('2A3', 'P1'), ('2L1', 'P1'), ('2L2', 'P1'),
  ('301', 'P1'), ('302', 'P1'), ('303', 'P1'), ('304', 'P1'), ('305', 'P1'),
  ('306', 'P1'), ('307', 'P1'), ('308', 'P1'), ('309', 'P1'), ('310', 'P1'),
  ('311', 'P1'), ('312', 'P1'), ('313', 'P1'), ('314', 'P1'),
  ('3L1', 'P1'), ('3L2', 'P1'),
  ('P2-102', 'P2'), ('P2-103', 'P2'), ('P2-106', 'P2'), ('P2-107', 'P2'),
  ('P2-108', 'P2'), ('P2-109', 'P2'), ('P2-202', 'P2'), ('P2-203', 'P2'),
  ('P2-206', 'P2'), ('P2-HUBS', 'P2')
on conflict (sala) do update set predio = excluded.predio, ativa = true;

-- ---------------------------------------------------------------------------
-- 4. poda do que o scraper acumulou
--
-- Antes do backfill de propósito: com CANCELADA ainda na tabela, o segundo
-- update casaria a linha consigo mesma e gravaria uma canônica fantasma.
-- ---------------------------------------------------------------------------

-- as 48 linhas velhas viram 42 canônicas mantidas, 6 grafias com rótulo
-- apagadas (CANCELADA e ONLINE incluídas)
delete from public.salas
where sala not in (
  '101','102','103','104','105','106','107','108','109','110','111','112',
  '113','114','201','202','203','204','205','206','207','208','209','210',
  '211','212','213','2A1','2A2','2A3','2L1','2L2','301','302','303','304',
  '305','306','307','308','309','310','311','312','313','314','3L1','3L2',
  'P2-102','P2-103','P2-106','P2-107','P2-108','P2-109','P2-202','P2-203',
  'P2-206','P2-HUBS'
);

-- ---------------------------------------------------------------------------
-- 5. backfill de sala_canon
--
-- Sem isto, `sala_canon` fica nulo até a próxima captura e o front, que subtrai
-- por canônica, mostraria o prédio inteiro como livre nessa janela.
-- ---------------------------------------------------------------------------

with alias (bruta, canon) as (values
  ('103 - DESIGN THINKING', '103'),
  ('113 (PRANCHETAS)', '113'),
  ('114 - LAB QUIMICA', '114'),
  ('114 LAB. QUIMICA', '114'),
  ('114 - LAB. FISICA', '114'),
  ('114 LAB. FISICA', '114'),
  ('102 (P2)', 'P2-102'),
  ('103 (P2)', 'P2-103'),
  ('103 (P2) NPJ', 'P2-103'),
  ('103 (P2) - NPJ', 'P2-103'),
  ('106 (P2)', 'P2-106'),
  ('107 (P2) LAB. METROLOGIA', 'P2-107'),
  ('107 (P2) - LAB.METROLOGIA', 'P2-107'),
  ('108 (P2) LAB. HIDRAULICA', 'P2-108'),
  ('108 (P2) LAB.HIDRAULICA E PNEUMATICA', 'P2-108'),
  ('LAB. HIDRAULICA - 108 (P2)', 'P2-108'),
  ('109 (P2) LAB MAKER', 'P2-109'),
  ('202 (P2)', 'P2-202'),
  ('202 (P2) LAB.REDES', 'P2-202'),
  ('203 (P2)', 'P2-203'),
  ('206 (P2)', 'P2-206'),
  ('HUBS', 'P2-HUBS')
)
update public.mapa_dia m
   set sala_canon = a.canon
  from alias a
 where btrim(m.sala) = a.bruta
   and m.sala_canon is null;

update public.mapa_dia m
   set sala_canon = s.sala
  from public.salas s
 where btrim(m.sala) = s.sala
   and m.sala_canon is null;

-- o que sobrou nulo é pseudo-sala, par concatenado ou grafia desconhecida:
-- nulo é a resposta certa, essas linhas não ocupam sala
