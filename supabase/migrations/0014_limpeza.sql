-- ibsala v5 — o que sobrou sai
--
-- `reclamacoes.disciplinas` veio da aba do v1 e nunca foi escrita nem lida: nem
-- pelo app, nem por function, nem por migration. Coluna que ninguém preenche
-- vira armadilha na próxima pessoa que abrir a tabela e achar que ali tem dado.
--
-- O que NÃO sai, e por quê: `audit_log` e `alunos.receber_email` também estavam
-- mortos, mas em vez de remover foram LIGADOS (0010 e a tela de Ajustes),
-- porque os dois são exigência de LGPD que o projeto já dizia cumprir.

alter table public.reclamacoes drop column if exists disciplinas;
