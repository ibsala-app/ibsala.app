# ibsala v2

Sistema de salas do Ibmec BH. Reescrita serverless do [app-salas], projetada pra
custo zero e manutenção zero ("always free, set it and forget it").

## Stack

| Camada | Onde | Custo |
|---|---|---|
| Banco + Auth + API | Supabase (Postgres, RLS, Auth Google) | free tier |
| Frontend (PWA estática) | Cloudflare Pages | free |
| Captura do mapa de salas | GitHub Actions (cron) | free |
| Push notifications | Supabase Edge Function + pg_cron | free tier |

Sem VM, sem Docker, sem `.env` em servidor. Secrets moram nas configurações
de cada plataforma (Supabase dashboard, GitHub Actions secrets).

## Estrutura

```
supabase/
  migrations/   # schema SQL versionado (fonte da verdade do banco)
  functions/    # edge functions (push, jobs)
web/            # PWA estática (deploy: Cloudflare Pages)
capture/        # scraper do mapa de salas (roda no GitHub Actions)
docs/           # arquitetura e runbooks
.github/
  workflows/    # cron da captura + CI
```

## Decisões (2026-07-23)

- **Auth**: exclusivamente "Entrar com Google" via Supabase Auth. Sem senha
  própria, sem token HMAC caseiro. Base de usuários começa do zero
  (re-cadastro no lançamento 2026.2).
- **Autorização**: RLS no Postgres. Papel admin via claim, não via password
  compartilhada.
- **API**: o frontend fala com o Postgres via supabase-js + RLS; lógica que
  não pode viver no client (push, captura, agregações de admin) vira edge
  function ou job.
- **Dados herdados**: nenhum. Disciplinas/salas são recapturadas; alunos se
  recadastram.

## Desenvolvimento

Migrations em `supabase/migrations/`, aplicadas em ordem. Nunca editar schema
pelo dashboard sem gerar migration correspondente.
