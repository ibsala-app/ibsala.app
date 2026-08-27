-- ibsala v5 — teto por aluno em materias, reclamacoes e push_subscriptions
--
-- As três tabelas que um aluno logado escreve não têm limite nenhum. A RLS diz
-- de QUEM é a linha, nunca QUANTAS ela pode ter, então um `for` com fetch na
-- console do navegador enche as três com a conta dele mesmo. Com 30 alunos isso
-- era teoria; num lançamento aberto para 1.000 pessoas é a primeira coisa que
-- alguém testa.
--
-- Matéria demais não é só volume: o `push-slot` monta a notificação a partir das
-- matérias do aluno, então uma conta com 5.000 matérias vira um push gigante e
-- puxa o cálculo do slot inteiro.
--
-- Os números saíram da grade real (6 slots x 6 dias = 36 aulas possíveis por
-- semana) e do uso real (ninguém tem 10 celulares). Mudar um limite é um
-- `create or replace` do trigger, não migration nova.
--
-- Rollback: drop dos três triggers e da função.

create or replace function public.quota_por_aluno()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  limite   int  := (TG_ARGV[0])::int;
  filtro   text := coalesce(TG_ARGV[1], 'true');
  recado   text := coalesce(TG_ARGV[2], 'Você chegou no limite desta lista.');
  quantas  int;
begin
  -- Serializa por aluno. Sem o lock, duas transações simultâneas leem o mesmo
  -- "antes" e passam as duas: contar em READ COMMITTED não é limite, é palpite.
  -- O lock é de transação, some sozinho no commit, e só disputa com outra
  -- escrita DO MESMO aluno NA MESMA tabela.
  perform pg_advisory_xact_lock(
    hashtextextended(TG_TABLE_NAME || ':' || new.aluno_id::text, 0));

  execute format(
    'select count(*) from public.%I where aluno_id = $1 and (%s)', TG_TABLE_NAME, filtro)
    into quantas
    using new.aluno_id;

  if quantas > limite then
    raise exception '%', recado using errcode = 'P0001';
  end if;

  return null;   -- AFTER trigger: o retorno é ignorado
end;
$$;

-- AFTER e não BEFORE, de propósito: num INSERT de várias linhas o trigger BEFORE
-- não enxerga as irmãs da mesma instrução, então UM POST com um array de 5.000
-- matérias passaria inteiro pelo limite. No AFTER as linhas já estão lá, a conta
-- inclui todas, e a exceção derruba a instrução inteira.
create trigger materias_quota
  after insert on public.materias
  for each row execute function public.quota_por_aluno(
    '40', 'true', 'Você chegou no limite de 40 matérias.');

-- reclamação aberta é fila de trabalho humano: o que pesa é quantas estão em
-- aberto, não quantas o aluno já mandou na vida
create trigger reclamacoes_quota
  after insert on public.reclamacoes
  for each row execute function public.quota_por_aluno(
    '10', 'resolvido_em is null',
    'Você já tem 10 reclamações em aberto. Espera a resposta das que mandou.');

-- o upsert por endpoint (0001) renova a MESMA linha quando o aparelho refaz a
-- inscrição, e ON CONFLICT DO UPDATE dispara trigger de update, não de insert:
-- renovar aparelho conhecido não passa por aqui nem no limite
create trigger push_subscriptions_quota
  after insert on public.push_subscriptions
  for each row execute function public.quota_por_aluno(
    '10', 'true', 'Limite de 10 aparelhos com aviso ligado nesta conta.');
