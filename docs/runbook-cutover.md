# Runbook do cutover — 02/08

Pré-requisitos (conferir ANTES do dia):

- `RESEND_API_KEY` nova salva em `~/.claude/secrets/ibsala-resend-v5.env`
  (setar no Supabase já é seguro pós-PR #3, que segura a fila em 401/403).
- Redirect allowlist do Auth cobrindo o domínio novo. **FEITO 26/07**: o front
  manda `redirectTo: location.origin + location.pathname` (`web/app.js`), e com
  `uri_allow_list` vazio o Supabase ignora esse valor e joga o usuário no
  `site_url`, ou seja, login feito em `ibsala.com.br` voltaria no `pages.dev`
  com a sessão gravada no origin errado. Allowlist agora:
  `https://ibsala.com.br/**,https://www.ibsala.com.br/**,https://ibsala.pages.dev/**`
  (o `pages.dev` fica na lista de propósito, pra continuar logando lá depois
  que o `site_url` virar). Conferir com
  `GET https://api.supabase.com/v1/projects/<ref>/config/auth`.

DESCOBERTA 25/07: custom domain NÃO dá pra deixar "pending" antes. Com a zona
na MESMA conta CF, o wizard do Pages não tem estado pendente: a tela final
("Confirm new DNS record") substitui o A do apex por CNAME→ibsala.pages.dev
no clique. Adicionar o custom domain É o flip. Fica pro dia. (Testado até a
tela final e abortado; A record conferido intacto por API depois.)

Zona CF `65a2154d2a736ba0564a006531b15d39`, token zone-scoped em
`~/.claude/secrets/ibsala-cloudflare.env`. Records atuais (25/07):

| id | tipo | nome | conteúdo |
|---|---|---|---|
| `546a79ec...` | A | ibsala.com.br | 35.196.182.217 (VM v1) |
| `346aff5c...` | CNAME | www | ibsala.com.br |

## 1. Smoke no pages.dev

Checklist de 25/07 repetido: home renderiza com dado vivo (pill de status),
login Google, sw.js e manifest 200, CSP presente.

**Push NÃO está validado em aparelho real** (correção de 26/07: a versão
anterior deste runbook afirmava que estava). `select count(*) from
push_subscriptions` = 0, ninguém inscrito. Fazer antes do dia: Josh instala a
PWA no iPhone, ativa avisos, e o disparo manual confirma a entrega
(`POST /functions/v1/push-slot`, header `x-cron-secret`, body
`{"slot":"noite2"}`). Se chegar no cutover sem esse teste, o item entra como
risco conhecido, não como validado.

## 2. Flip do DNS (o cutover em si)

**Caminho primário (dashboard, 1 clique por domínio):** Workers & Pages →
ibsala → Custom domains → Set up a custom domain → `ibsala.com.br` → Continue →
a tela "Confirm new DNS record" mostra A→CNAME → **Activate domain** (isso
registra o domínio no Pages E troca o record de uma vez). Repetir pra
`www.ibsala.com.br`. O cert do edge já cobre o apex+www (Universal SSL da zona,
ativa desde 24/07).

**Fallback/rollback via API** (token zone-scoped alcança DNS; só vale como
rollback ou se o dash estiver fora — o PUT sozinho NÃO registra o domínio no
Pages):

```bash
source ~/.claude/secrets/ibsala-cloudflare.env

# apex: A → CNAME flattened pro Pages, proxied
curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/546a79ec<id-completo>" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"CNAME","name":"ibsala.com.br","content":"ibsala.pages.dev","proxied":true,"ttl":1}'

# www: aponta direto pro Pages, proxied
curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/346aff5c<id-completo>" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"CNAME","name":"www.ibsala.com.br","content":"ibsala.pages.dev","proxied":true,"ttl":1}'
```

IDs completos dos dois records (não ficam versionados aqui de propósito, repo
público):

```bash
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  | python3 -c 'import sys,json
for r in json.load(sys.stdin)["result"]:
    if r["name"] in ("ibsala.com.br","www.ibsala.com.br"): print(r["type"], r["name"], r["id"])'
```

Rollback = os mesmos PUTs de volta pra `{"type":"A","content":"35.196.182.217","proxied":false}`.

Validar: `curl -sI https://ibsala.com.br | grep -i cf-ray` (proxied) e a home
servindo o v5 (título/asset do Pages, não o Flask).

## 2.1 Auth: virar o `site_url` (logo depois do flip)

Com a allowlist do pré-requisito o login já funciona no domínio novo, mas o
`site_url` continua em `pages.dev` e é ele o destino de fallback. Virar:

```bash
source ~/.claude/secrets/ibsala-supabase.env
curl -s -X PATCH -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.supabase.com/v1/projects/jbdmkbivmflauushiqca/config/auth" \
  -d '{"site_url":"https://ibsala.com.br"}'
```

Rollback = mesmo PATCH com `https://ibsala.pages.dev`. Validar entrando de
verdade em `https://ibsala.com.br` (a URL depois do Google tem que voltar no
domínio novo, não no `pages.dev`).

## 3. Email de re-cadastro (v1 ainda vivo)

Texto e procedimento em [[email-recadastro|docs/email-recadastro.md]]. Com o
DNS já flipado, o POST vai na VM direto:
`curl --resolve ibsala.com.br:443:35.196.182.217 https://ibsala.com.br/api/adm/email/custom ...`
Conferir no log do flask: `Email custom enviado: 67 ok`.

## 4. Migrar o email pro v5 (ordem rígida)

1. Na conta Resend VELHA: remover o domínio `mail.ibsala.com.br`.
2. Na conta Resend NOVA (Google ibsala.app): adicionar `mail.ibsala.com.br`.
   DKIM/SPF/MX já estão na zona CF (preservados em 23/07), verifica na hora.
3. `supabase secrets set RESEND_API_KEY=<key nova> --project-ref jbdmkbivmflauushiqca`
4. Prova: item id=1 da `email_queue` (canário "[teste hold] ignorar" plantado
   em 25/07) deve SAIR no próximo tick do cron pra jazzedistel@gmail.com.
   Antes da verificação do domínio, a resposta da function é `{hold: 403}` e
   `tentativas` fica em 0 (PR #3). Depois de receber o canário, deletar a linha.

## 5. Funeral da VM (pode ser dias depois, sem pressa)

1. Atlética migra pra Oracle ANTES de desligar (VM é compartilhada).
2. Backup final: `.env` + logs + cache da VM (script de backup já roda 03:00).
3. Bundle do repo: `~/cerebro-backups/app-salas-pre-funeral-2026-07-25.bundle`
   (gerado em 25/07, `git bundle verify` ok). Deletar `joshazze/app-salas`.
4. Revogar as 4 credenciais vazadas do v1: ADM_PASSWORD (morre com a VM),
   service account do Sheets (console GCP), VAPID velho (morre com a VM),
   RESEND key velha (dashboard conta velha) — a key velha é a ÚLTIMA, só
   depois do re-cadastro enviado.
5. Desligar `instance-ibsala` no console GCP (parar, não deletar, por 1-2
   semanas de arrependimento; deletar depois).
6. Sentry v1 (org ibsala, python-flask): arquivar/mutar alertas.

## 6. Pós

- Monitorar Sentry v5 (org ibsala-pp) por 48h.
- `vault`: atualizar ibsala.md (v1 morto), ibsala-v5-master.md, repos.md.
- ImprovMX do v1 morre de vez (decisão 24/07: suporte é o Gmail direto).
