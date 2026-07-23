# Design v2 — mapeamento do v1

Fonte: leitura do `app-salas` em 2026-07-23 (vp = `visualizar_planilha.py`,
`server.py`, `scheduler.py`).

## Dados: Sheets → Postgres

| Aba v1 | Tabela v2 | Mudanças |
|---|---|---|
| Alunos | `alunos` | `id` = uuid do Supabase Auth; flags string → boolean; `role` substitui senha de admin |
| Materias | `materias` | `dia` texto PT → smallint 1-6; unique (aluno, codigo, dia) |
| Salas | `salas` | igual; escrita só pelo job de captura |
| Disciplinas_Historico | `disciplinas_historico` | `codigo` vira PK com upsert (v1 só fazia append) |
| cache/mapa_salas_*.csv | `mapa_dia` | CSV efêmero vira tabela com `merge_key` (md5 das 6 MERGE_COLS do v1) + retenção diária via pg_cron |
| Push_Subscriptions | `push_subscriptions` | PK em `endpoint` dá o ownership-guard; RLS limita ao dono |
| Reclamacoes | `reclamacoes` | `resolvido` string → `resolvido_em timestamptz` |
| AuditLog | `audit_log` | igual, `ip` como inet |
| Email_Queue | `email_queue` | mantida pra retry; consumida por edge function agendada |

## Captura (GitHub Actions, substitui o APScheduler)

- Fonte: planilha da universidade (worksheet 0), export CSV público
  `https://docs.google.com/spreadsheets/d/{ID}/export?format=csv` (fallback do
  v1 vira caminho principal: dispensa a service account do Google).
- Parser portado do v1: seções por título de categoria (GRADUAÇÃO MANHÃ/TARDE/
  NOITE, OUTRAS RESERVAS), header em "Turma", `codigo` extraído do split em "/",
  colunas Categoria/Turma/Codigo/Disciplina/Horario/Professor/Sala.
- Upsert em `mapa_dia` on conflict (data, merge_key) + upsert de
  `disciplinas_historico` e `salas` (side-effect igual ao v1), via service key.
- Cron: dias úteis a cada 20 min 07:00-21:40 + 22:00 + 05:00 (espelha o v1).
  Actions cron é UTC: BRT+3.

## Slots e cruzamento (lógica pura, portar como está)

- 6 slots: manha1 06:00-09:29 · manha2 09:30-12:59 · tarde1 13:00-15:29 ·
  tarde2 15:30-17:59 · noite1 18:00-18:59 · noite2 19:00-23:59.
- `aulas-hoje`: materias do aluno (dia = hoje) × `mapa_dia` por `codigo`
  (fallbacks fuzzy do v1 ficam pra depois; começar só com match por codigo).
- `agora`: slot pelo relógio BRT + linhas cujo intervalo `horario` contém o
  minuto atual + salas livres do slot. Vira RPC SQL ou view; client só lê.

## Push (edge function + pg_cron)

- pg_cron dispara ~50 min antes de cada slot (06:40, 09:00, 12:10, 15:00,
  17:10, 18:10, dias úteis) chamando a edge function `push-slot`.
- Function: join materias × mapa_dia do slot, agrupa subs por aluno, envia
  web push (VAPID novo, par gerado no setup); 410/404 remove a sub.
- Conteúdo igual ao v1: título "Sala X", body "Disciplina · Prof. Nome ·
  07:30-09:20".

## Email (Resend, key nova)

Mantém: welcome no cadastro, aviso de exclusão de conta, aviso de login-as,
comunicados de admin, inbound de suporte (webhook Svix). Tudo em edge
functions; `email_queue` + cron matinal pra retry, como no v1.

## Fluxos de auth

- Entrar com Google (Supabase Auth) → se não tem perfil, tela de escolher
  username (`username_disponivel`) → insert em `alunos` (RLS: id = auth.uid()).
- Admin = `alunos.role = 'admin'` (setado manualmente no dashboard uma vez).
  Login-as do v1 sai; admin enxerga dados via policies `is_admin()`.
- `touch_ultimo_acesso()` no boot do app, throttle 6h no client.

## LGPD

- Export: RPC que devolve JSON do perfil + materias + reclamacoes + subs.
- Self-delete: `auth.admin.deleteUser` via edge function → cascade FK apaga
  tudo (o `delete_aluno_cascade` do v1 vira DDL).
- Retenção 12m inativos: pg_cron mensal (portar `rotina_retencao`).

## Fora do v2.0 (anotado, não perdido)

- Fuzzy match de aulas (3 palavras / turma+disciplina) — v1 usa como fallback
  do lookup por codigo; medir se faz falta antes de portar.
- Resend Contacts/audience sync do painel admin.
- Recuperar username por email (Google-only torna raro).
