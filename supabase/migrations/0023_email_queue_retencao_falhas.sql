-- ibsala v5: a retenção da fila de email também apaga o que nunca saiu
--
-- A 0010 criou o `email-queue-retencao` apagando só linha enviada com mais de 30
-- dias. Linha que esgotou as 5 tentativas (endereço que o Resend recusa, template
-- quebrado) nunca vira `enviado`, e o `claim_emails` da 0015 para de pegá-la:
-- ficava no banco pra sempre, com o endereço de alguém. A `apagar-conta` passa a
-- limpar a fila do aluno na hora; isto cobre o resto.
--
-- `cron.schedule` com o mesmo nome substitui o job, sem duplicar.
--
-- Rollback: `cron.schedule` com o corpo da 0010.

select cron.schedule('email-queue-retencao', '10 7 * * *', $$
  delete from public.email_queue
    where criado < now() - interval '30 days'
      and (enviado or tentativas >= 5);
$$);
