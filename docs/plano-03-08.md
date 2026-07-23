# Plano de lançamento — 03/08/2026 (início das aulas 2026.2)

Contexto: billing da VM GCP pendente (decisão: não pagar). O v1 pode cair a
qualquer momento; julho é férias, impacto baixo. O v2 nasce serverless e o
cutover é por DNS.

## Cronograma

| Datas | Entrega |
|---|---|
| 24-25/07 | Supabase + Cloudflare sob `ibsala.app@gmail.com`; schema + RLS aplicados; captura rodando no GitHub Actions; migração da atlética pra Oracle |
| 26-30/07 | Core: auth Google, matérias, aulas-hoje, agora, admin |
| 31/07-01/08 | Push + PWA + frontend novo (redesign) |
| 02/08 | Smoke completo, DNS do `ibsala.com.br` apontado, aviso de re-cadastro |
| pós-cutover | Desligar VM GCP, revogar credenciais v1 (GCP service account, Resend, VAPID, ADM), deletar repo `app-salas` (bundle local antes) |

## Gates (nada de "merge = deploy")

- Captura só está pronta quando o Actions rodar sozinho num horário agendado
  e a tabela refletir o mapa do dia.
- Push só está pronto com notificação recebida em iPhone real (PWA instalada).
- Cutover só acontece com smoke visual em prod (não só curl).

## Pendências herdadas do v1 que morrem no descomissionamento

- Rotação das 4 credenciais vazadas (`d386a18`) vira revogação.
- `git filter-repo` do histórico vira delete do repo.
- Backup GPG diário da VM vira backup gerenciado do Supabase.
