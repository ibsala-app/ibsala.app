-- LGPD: export de dados (art. 18) + retenção automática (12m inativos / 6m
-- reclamações resolvidas), espelhando a política do v1.

create or replace function public.exportar_meus_dados()
returns jsonb
language sql security definer
set search_path = public
as $$
  select jsonb_build_object(
    'perfil', (select to_jsonb(a) - 'id' from alunos a where a.id = auth.uid()),
    'materias', (select coalesce(jsonb_agg(to_jsonb(m) - 'aluno_id' - 'id'), '[]'::jsonb)
                 from materias m where m.aluno_id = auth.uid()),
    'avisos_dispositivos', (select coalesce(jsonb_agg(jsonb_build_object(
                              'endpoint', p.endpoint, 'criado', p.criado)), '[]'::jsonb)
                            from push_subscriptions p where p.aluno_id = auth.uid()),
    'reclamacoes', (select coalesce(jsonb_agg(to_jsonb(r) - 'aluno_id' - 'id'), '[]'::jsonb)
                    from reclamacoes r where r.aluno_id = auth.uid())
  );
$$;

-- retenção: dia 1 às 03:30 BRT (06:30 UTC)
select cron.schedule('retencao-lgpd', '30 6 1 * *', $$
  delete from auth.users u
    using public.alunos a
    where a.id = u.id and a.ultimo_acesso < now() - interval '12 months';
  delete from public.reclamacoes
    where resolvido_em is not null and resolvido_em < now() - interval '6 months';
$$);
