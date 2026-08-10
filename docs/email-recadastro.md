# Email de re-cadastro (cutover 02/08)

Disparo: pelo v1 (`/api/adm/email/custom`), com o v1 ainda vivo, DEPOIS do flip
de DNS (o link precisa cair no v5). Remetente `avisos@mail.ibsala.com.br`, que
só existe enquanto o domínio estiver verificado na conta Resend velha. É o
último envio do v1; só depois dele o domínio `mail.ibsala.com.br` migra pra
conta nova.

O endpoint escapa o texto, converte quebra de linha em `<br>` e linkifica URLs
(PR #84 do app-salas). A mensagem abaixo vai como texto puro no payload.

## Assunto

```
IBSALA novo no ar: entre de novo em 1 minuto
```

## Mensagem (payload `mensagem`, texto puro)

```
Oi! O IBSALA ganhou uma versão nova, mais rápida e pronta pro semestre. O endereço é o mesmo de sempre: https://ibsala.com.br

Seu cadastro antigo não migra sozinho. Pra continuar recebendo sala e horário das suas aulas, entre de novo (leva 1 minuto):

1. Abra https://ibsala.com.br e toque em "Entrar"
2. Toque em "Entrar com Google", com a mesma conta de sempre
3. Escolha seu username e toque em "Criar conta"
4. Em "Minhas aulas", use "Buscar disciplinas" pra colocar suas matérias de volta
5. Ainda em "Minhas aulas", toque em "Ativar avisos neste aparelho": a sala de cada aula chega uns 50 minutos antes do horário

Quem já tinha o app na tela de início pode precisar remover e adicionar de novo (Safari: Compartilhar > Adicionar à Tela de Início).

Dúvidas ou problema no acesso: ibsala.app@gmail.com

Equipe IBSALA / Liga IBtech
```

## Como disparar

1. Fonte dos destinatários: `~/.claude/secrets/ibsala-alunos-export-2026-07-24.csv`
   (67 alunos extraídos do v1 em 24/07).
2. Login admin no v1 → `adm_token` (12h de validade).
3. `POST https://ibsala.com.br/api/adm/email/custom` com
   `{adm_user, adm_token, assunto, mensagem, destinatarios:[{email},...]}`.
   ATENÇÃO: no momento do disparo o DNS já aponta pro v5, então o POST vai
   direto no IP da VM com `--resolve ibsala.com.br:443:35.196.182.217` (o nginx
   do v1 continua servindo o vhost) ou via SSH + curl no `127.0.0.1:5000`.
4. Throttle de 0.5s/envio já no servidor: 67 emails ≈ 35s. Conferir no log:
   `Email custom enviado: 67 ok, 0 erros de 67`.
5. Rate-limit do endpoint: 2 disparos por 5 min. Errou o texto? Espere a janela.

Testado em 25/07 com 2 destinatários reais: link clicável no Gmail, pontuação
fora do anchor, `2 ok, 0 erros`.

## Correção de 10/08 (antes do envio)

Os passos apontavam pra telas que o v5 não tem. Conferido contra
`web/index.html`: não existe "Configurações", o menu tem "Salas agora",
"Buscar disciplinas" e "Entrar" (que vira `Minhas aulas (username)` depois do
login, `web/app.js:184`), matéria entra por "Buscar disciplinas" dentro dessa
tela e o push é o botão "Ativar avisos neste aparelho".

Faltava também o passo do username: depois do Google o aluno cai em "Escolha
seu username" + "Criar conta", e é ali que a conta nasce de fato. Mandar 70
emails com o caminho errado num envio que não tem rollback seria o pior lugar
pra errar.

Destinatários: **70**, não os 67 do CSV de 24/07 (entraram
`giseletessari@`, `santossouza.ph04@`, `smfamoura@`). Lista viva puxada de
`POST /api/adm/alunos` no dia do envio, não do CSV.
