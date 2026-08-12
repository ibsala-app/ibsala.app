-- ibsala v5 — aceite dos termos de uso, com prova
--
-- Até aqui dava pra criar conta sem nunca ver a política de privacidade: ela
-- existia e estava linkada em UM lugar, o rodapé da home. Agora o aceite é
-- obrigatório no passo do username, que é o instante em que a conta nasce, e
-- fica gravado com data e versão. Sem isso, "o aluno concordou" seria uma
-- afirmação sem lastro, exatamente o tipo de coisa que a conversa do QR code
-- com o Coutinho e o marketing vai cobrar.

alter table public.alunos
  add column if not exists termos_em      timestamptz,
  add column if not exists termos_versao  text;

-- quem já tem conta aceitou o que existia no cadastro dele (a política, linkada
-- na home). Marcar retroativo com a data de criação e versão 0 é mais honesto
-- que fingir que aceitaram a versão 1, e mantém a coluna utilizável como filtro.
update public.alunos
   set termos_em = criado, termos_versao = '0-anterior-aos-termos'
 where termos_em is null;

-- a partir daqui, insert sem aceite não passa
drop policy if exists alunos_insert_own on public.alunos;

create policy alunos_insert_own on public.alunos
  for insert with check (
    id = auth.uid()
    and role = 'aluno'
    and not bloqueado
    and lower(email) = lower(auth.jwt() ->> 'email')
    and termos_em is not null
    and termos_versao is not null
  );

-- o aceite é registro, não preferência: nem o dono muda depois. O guarda de
-- colunas da 0010 passa a cobrir os dois campos.
create or replace function public.alunos_guarda_colunas()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  if new.id is distinct from old.id
     or new.email is distinct from old.email
     or new.role is distinct from old.role
     or new.bloqueado is distinct from old.bloqueado
     or new.criado is distinct from old.criado
     or new.termos_em is distinct from old.termos_em
     or new.termos_versao is distinct from old.termos_versao then
    raise exception 'id, email, role, bloqueado, criado e aceite dos termos não mudam pelo app'
      using errcode = '42501';
  end if;

  return new;
end;
$$;
