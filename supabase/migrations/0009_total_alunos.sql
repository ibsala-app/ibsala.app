-- ibsala v5 — contagem pública de alunos cadastrados
--
-- A pill do topo passa a mostrar "18 alunos", que é prova social pra quem chega
-- pelo QR code e ainda não tem conta.
--
-- A tabela `alunos` NÃO pode virar legível: a política é
-- `id = auth.uid() or is_admin()`, e é ela que garante que um aluno não enxerga
-- o dado do outro. Então a contagem sai por função `security definer`, que
-- devolve só o agregado, nunca linha.

create or replace function public.total_alunos()
returns int
language sql
security definer
stable
set search_path = public
as $$
  select count(*)::int from public.alunos;
$$;

revoke all on function public.total_alunos() from public;
grant execute on function public.total_alunos() to anon, authenticated;
