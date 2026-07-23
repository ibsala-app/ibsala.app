-- ibsala v2 — schema inicial
-- Mapeia as 8 abas do Google Sheets do v1 pra Postgres com RLS.
-- Auth fica no Supabase Auth (Google-only); "alunos" é a tabela de perfil.

create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.alunos
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ---------------------------------------------------------------------------
-- perfil (aba Alunos)
-- ---------------------------------------------------------------------------

create table public.alunos (
  id             uuid primary key references auth.users (id) on delete cascade,
  username       text not null,
  email          text not null,
  role           text not null default 'aluno' check (role in ('aluno', 'admin')),
  bloqueado      boolean not null default false,
  receber_email  boolean not null default true,
  criado         timestamptz not null default now(),
  ultimo_acesso  timestamptz
);

create unique index alunos_username_key on public.alunos (lower(username));

alter table public.alunos enable row level security;

create policy alunos_select_own on public.alunos
  for select using (id = auth.uid() or public.is_admin());

create policy alunos_insert_own on public.alunos
  for insert with check (id = auth.uid() and role = 'aluno');

create policy alunos_update_own on public.alunos
  for update using (id = auth.uid() or public.is_admin());

-- username livre? (fluxo de cadastro checa antes de inserir)
create or replace function public.username_disponivel(candidato text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select not exists (
    select 1 from public.alunos where lower(username) = lower(candidato)
  );
$$;

-- carimbo de último acesso (throttle fica no client; smart-write do v1 era 6h)
create or replace function public.touch_ultimo_acesso()
returns void
language sql security definer
set search_path = public
as $$
  update public.alunos set ultimo_acesso = now() where id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- matérias do aluno (aba Materias)
-- ---------------------------------------------------------------------------

-- dia: 1=SEGUNDA … 6=SABADO (v1 usava o nome PT com acento; padronizado aqui)
create table public.materias (
  id          bigint generated always as identity primary key,
  aluno_id    uuid not null references public.alunos (id) on delete cascade,
  dia         smallint not null check (dia between 1 and 6),
  turma       text not null,
  disciplina  text not null,
  professor   text,
  codigo      text not null,
  criado      timestamptz not null default now(),
  unique (aluno_id, codigo, dia)
);

create index materias_aluno_idx on public.materias (aluno_id);

alter table public.materias enable row level security;

create policy materias_own on public.materias
  for all using (aluno_id = auth.uid() or public.is_admin())
  with check (aluno_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- catálogo derivado da captura (abas Salas + Disciplinas_Historico)
-- escrita: só service_role (job de captura); leitura pública
-- ---------------------------------------------------------------------------

create table public.salas (
  sala    text primary key,
  predio  text not null default 'P1'
);

create table public.disciplinas_historico (
  codigo      text primary key,
  turma       text,
  disciplina  text not null,
  professor   text,
  atualizado  timestamptz not null default now()
);

alter table public.salas enable row level security;
alter table public.disciplinas_historico enable row level security;

create policy salas_read on public.salas for select using (true);
create policy disc_hist_read on public.disciplinas_historico for select using (true);

-- ---------------------------------------------------------------------------
-- mapa do dia (o CSV mapa_salas_YYYY-MM-DD do v1)
-- merge key do v1: Categoria,Turma,Codigo,Disciplina,Horario,Professor (keep last)
-- ---------------------------------------------------------------------------

create table public.mapa_dia (
  id         bigint generated always as identity primary key,
  data       date not null,
  categoria  text not null,
  turma      text,
  codigo     text,
  disciplina text,
  horario    text,          -- formato "07:30/09:20", como na fonte
  professor  text,
  sala       text,
  merge_key  text generated always as (
    md5(coalesce(categoria,'') || '|' || coalesce(turma,'') || '|' ||
        coalesce(codigo,'')    || '|' || coalesce(disciplina,'') || '|' ||
        coalesce(horario,'')   || '|' || coalesce(professor,''))
  ) stored,
  capturado  timestamptz not null default now(),
  unique (data, merge_key)
);

create index mapa_dia_codigo_idx on public.mapa_dia (data, codigo);

alter table public.mapa_dia enable row level security;
create policy mapa_dia_read on public.mapa_dia for select using (true);

-- retenção: só o dia corrente interessa (v1 apagava CSVs antigos)
select cron.schedule(
  'mapa-dia-retencao', '30 3 * * *',
  $$delete from public.mapa_dia where data < current_date$$
);

-- ---------------------------------------------------------------------------
-- push (aba Push_Subscriptions)
-- ---------------------------------------------------------------------------

create table public.push_subscriptions (
  endpoint  text primary key,
  aluno_id  uuid not null references public.alunos (id) on delete cascade,
  p256dh    text not null,
  auth      text not null,
  criado    timestamptz not null default now()
);

create index push_aluno_idx on public.push_subscriptions (aluno_id);

alter table public.push_subscriptions enable row level security;

-- upsert só do dono; a PK em endpoint dá o ownership-guard do v1 de graça:
-- endpoint de outro aluno não passa no with check do update
create policy push_own on public.push_subscriptions
  for all using (aluno_id = auth.uid())
  with check (aluno_id = auth.uid());

-- ---------------------------------------------------------------------------
-- reclamações (aba Reclamacoes)
-- ---------------------------------------------------------------------------

create table public.reclamacoes (
  id           bigint generated always as identity primary key,
  aluno_id     uuid references public.alunos (id) on delete cascade,
  descricao    text not null,
  disciplinas  text,
  criado       timestamptz not null default now(),
  resolvido_em timestamptz
);

alter table public.reclamacoes enable row level security;

create policy reclamacoes_insert on public.reclamacoes
  for insert with check (aluno_id = auth.uid());

create policy reclamacoes_select on public.reclamacoes
  for select using (aluno_id = auth.uid() or public.is_admin());

create policy reclamacoes_admin_update on public.reclamacoes
  for update using (public.is_admin());

-- ---------------------------------------------------------------------------
-- auditoria de admin (aba AuditLog — LGPD) e fila de email (aba Email_Queue)
-- escrita via service_role / edge functions; leitura só admin
-- ---------------------------------------------------------------------------

create table public.audit_log (
  id        bigint generated always as identity primary key,
  ts        timestamptz not null default now(),
  adm       uuid,
  aluno_id  uuid,
  ip        inet,
  acao      text not null
);

create table public.email_queue (
  id         bigint generated always as identity primary key,
  to_email   text not null,
  subject    text not null,
  body       text not null,
  enviado    boolean not null default false,
  tentativas int not null default 0,
  criado     timestamptz not null default now()
);

alter table public.audit_log enable row level security;
alter table public.email_queue enable row level security;

create policy audit_admin_read on public.audit_log
  for select using (public.is_admin());

create policy email_queue_admin_read on public.email_queue
  for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- config global (trava do site etc.)
-- ---------------------------------------------------------------------------

create table public.config (
  key    text primary key,
  value  jsonb not null
);

alter table public.config enable row level security;
create policy config_read on public.config for select using (true);
create policy config_admin_write on public.config
  for all using (public.is_admin()) with check (public.is_admin());

insert into public.config (key, value) values ('travado', 'false');
