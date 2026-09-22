-- 0005: job queues, cron schedules, realtime publication.

select pgmq.create('sync_jobs');
select pgmq.create('triage_jobs');
select pgmq.create('pipeline_jobs');
select pgmq.create('digest_jobs');

-- Poke backstop: drain any queue with waiting messages every minute. The poke
-- pattern (enqueue_and_poke) makes this a no-op in the normal case.
select cron.schedule('poke-nonempty-queues', '* * * * *', $$select public.poke_nonempty_queues()$$);

-- State-machine timers: snooze returns, follow-up nudges, overdue escalation.
select cron.schedule('sla-sweep', '*/5 * * * *', $$select public.run_sla_sweep()$$);

-- Always-on Gmail polling safety net (push is the fast path).
select cron.schedule('gmail-poll-sweep', '*/15 * * * *', $$select public.gmail_poll_sweep()$$);

-- Gmail watches expire every 7 days; renew when within 36h of expiry.
select cron.schedule('gmail-watch-renewal', '0 6 * * *', $$select public.gmail_watch_renewal_sweep()$$);

-- Morning digest dispatch (per-user local hour), checked hourly.
select cron.schedule('digest-dispatch', '5 * * * *', $$select public.enqueue_due_digests()$$);

-- Keep cron history bounded.
select cron.schedule('cron-history-cleanup', '0 3 * * 0',
  $$delete from cron.job_run_details where end_time < now() - interval '14 days'$$);

-- Realtime: queue_items changes drive UI cache invalidation. postgres_changes
-- subscriptions are RLS-filtered per user.
alter publication supabase_realtime add table public.queue_items;
