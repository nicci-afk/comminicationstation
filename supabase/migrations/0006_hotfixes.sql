-- Hotfixes applied to the live project during the build session, captured here
-- so migrations 0001–0006 reproduce production exactly.
--   * poke_worker_split_function — workers moved into their own edge function
--     ("workers") to fit deploy-call size limits; the poke now targets
--     app_config key `workers_base_url` (…/functions/v1/workers) instead of
--     the api function's base url.
--   * responded_to_awaiting_reply — closing the loop on outbound consistency:
--     marking a conversational item (needs_reply / urgent / scheduling)
--     "responded" converts it to awaiting_reply with a follow-up timer, so an
--     ignored reply resurfaces as a nudge instead of vanishing.

create or replace function public.poke_worker(p_queue text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_base text := public.get_app_config('workers_base_url') ->> 'url';
  v_anon text := public.get_app_config('anon_key') ->> 'key';
  v_secret_id uuid := (public.get_app_config('worker_secret_vault_id') ->> 'id')::uuid;
  v_secret text;
  v_fn text;
begin
  if v_base is null or v_anon is null or v_secret_id is null then
    return;
  end if;
  v_secret := public.vault_read_secret(v_secret_id);
  v_fn := case p_queue
    when 'sync_jobs' then 'gmail-sync-worker'
    when 'triage_jobs' then 'triage-worker'
    when 'pipeline_jobs' then 'pipeline-worker'
    when 'digest_jobs' then 'digest-worker'
    else null
  end;
  if v_fn is null then
    return;
  end if;
  perform net.http_post(
    url := v_base || '/' || v_fn,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_anon,
      'x-worker-secret', v_secret
    ),
    body := jsonb_build_object('queue', p_queue),
    timeout_milliseconds := 5000
  );
end;
$$;

create or replace function public.log_queue_transition()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor text;
begin
  if new.state is distinct from old.state then
    if new.state = 'responded'
       and new.category in ('needs_reply', 'urgent', 'scheduling') then
      new.state := 'awaiting_reply';
      new.follow_up_at := coalesce(new.follow_up_at, now() + interval '4 days');
      new.waiting_since := now();
    end if;
    v_actor := case when auth.uid() is not null then 'user' else 'system' end;
    insert into public.queue_item_events
      (user_id, queue_item_id, from_state, to_state, actor, reason, evidence)
    values (
      new.user_id, new.id, old.state, new.state, v_actor,
      coalesce(current_setting('app.transition_reason', true), ''),
      coalesce(nullif(current_setting('app.transition_evidence', true), ''), '{}')::jsonb
    );
    new.updated_at := now();
  end if;
  return new;
end;
$$;
