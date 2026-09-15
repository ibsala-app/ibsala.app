-- ibsala v5: aluno só escreve `aluno_id` e `descricao` na reclamação
--
-- A quota da 0016 conta reclamação ABERTA (`resolvido_em is null`), mas a
-- policy de insert só olhava o dono da linha, e o grant padrão do Supabase dá
-- insert em todas as colunas. Um POST com `resolvido_em: 'infinity'` entrava já
-- resolvido: a trigger não contava, a linha não aparecia no painel do admin (que
-- lista só as abertas) e a retenção de 6 meses nunca apagava, porque infinity
-- nunca fica velho. Volume ilimitado, invisível e eterno. Do mesmo jeito dava
-- pra forjar `criado` e furar a ordem da fila do admin.
--
-- Grant por coluna resolve sem trigger: o front já manda só as duas. O admin
-- continua resolvendo pela policy de update, que não muda.
--
-- `descricao` também não tinha teto no servidor, só o `maxlength=500` do
-- formulário: dez reclamações de vários MB mandadas direto pelo REST travavam o
-- painel do admin no celular. `not valid` para não reprovar por linha antiga.
--
-- Rollback:
--   grant insert on public.reclamacoes to authenticated;
--   alter table public.reclamacoes drop constraint reclamacoes_descricao_tamanho;

revoke insert on public.reclamacoes from anon, authenticated;
grant insert (aluno_id, descricao) on public.reclamacoes to authenticated;

alter table public.reclamacoes
  add constraint reclamacoes_descricao_tamanho
  check (char_length(descricao) between 1 and 500) not valid;
