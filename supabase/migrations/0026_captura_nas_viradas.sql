-- ibsala v5 — captura a cada 2 minutos em volta das viradas de horário
--
-- A captura de 20 em 20 minutos (0008) deixa um buraco justo quando o aluno
-- mais olha o app: na troca de aula. Professor que muda de sala, aula
-- cancelada em cima da hora e reserva lançada às 13:25 só apareciam às 13:40.
--
-- Agora, de 10 minutos antes a 10 minutos depois de cada início e fim de aula,
-- a captura roda a cada 2 minutos. As viradas saem do mapa de 01/10/2026 (as
-- que aparecem em 13 ou mais aulas): 07:30, 09:20, 09:50, 11:40, 13:30, 15:20,
-- 15:50, 17:40, 18:40 e 22:30. Os minutos 0, 20 e 40 ficam de fora porque a
-- 0008 já dispara neles, e duas capturas no mesmo minuto só disputariam o
-- mesmo upsert. São 95 execuções extras por dia útil, longe do teto do plano.
-- Exceção: às 22h a 0008 só dispara em 22:00, então a janela das 22:30 cobre
-- de 22:22 a 22:38, sem as pontas de 22:20 e 22:40.
--
-- Horários em UTC (BRT+3). O de 01h UTC é 22:30 BRT do dia anterior, por
-- isso roda de terça a sábado, igual ao `captura-noite` da 0008.
--
-- Rollback: `select cron.unschedule(jobname) from cron.job where jobname like 'captura-virada-%';`

select cron.schedule('captura-virada-0720', '22,24,26,28,30,32,34,36,38 10 * * 1-5',
  $$select public.disparar_captura()$$);
select cron.schedule('captura-virada-0920', '10,12,14,16,18,22,24,26,28,30,42,44,46,48,50,52,54,56,58 12 * * 1-5',
  $$select public.disparar_captura()$$);
select cron.schedule('captura-virada-1140', '30,32,34,36,38,42,44,46,48,50 14 * * 1-5',
  $$select public.disparar_captura()$$);
select cron.schedule('captura-virada-1330', '22,24,26,28,30,32,34,36,38 16 * * 1-5',
  $$select public.disparar_captura()$$);
select cron.schedule('captura-virada-1520', '10,12,14,16,18,22,24,26,28,30,42,44,46,48,50,52,54,56,58 18 * * 1-5',
  $$select public.disparar_captura()$$);
select cron.schedule('captura-virada-1740', '30,32,34,36,38,42,44,46,48,50 20 * * 1-5',
  $$select public.disparar_captura()$$);
select cron.schedule('captura-virada-1840', '30,32,34,36,38,42,44,46,48,50 21 * * 1-5',
  $$select public.disparar_captura()$$);
select cron.schedule('captura-virada-2230', '22,24,26,28,30,32,34,36,38 1 * * 2-6',
  $$select public.disparar_captura()$$);
