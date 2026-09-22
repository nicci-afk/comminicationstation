-- 0022_live_schema_reconciliation
-- Purpose: make a clean repository rebuild match the current live Message Command Center
-- behavior without rewriting historical migrations.
--
-- This migration is intentionally idempotent and limited to two verified rebuild drifts:
--   1) queue_items_active_thread must exclude expense split clones.
--   2) recategorize_queue_item must not auto-create sender rules for variable
--      Amazon/Walmart/Sam's Club sender addresses.
--
-- On the live production database these changes are already present, so this migration
-- is designed to be a semantic no-op there. It has NOT been applied to production.

begin;

-- Live production predicate:
--   is_split_clone = false
--   AND state IN ('new','needs_attention','snoozed','awaiting_reply','backlog','fyi')
-- Historical repo 0003 lacks the is_split_clone predicate because that column was
-- introduced later and the live hotfix was not committed as a standalone migration.
do $$
declare
  v_indexdef text;
begin
  select pg_get_indexdef(i.indexrelid)
    into v_indexdef
  from pg_index i
  join pg_class idx on idx.oid = i.indexrelid
  join pg_namespace n on n.oid = idx.relnamespace
  where n.nspname = 'public'
    and idx.relname = 'queue_items_active_thread';

  if v_indexdef is null
     or position('is_split_clone = false' in lower(v_indexdef)) = 0 then
    drop index if exists public.queue_items_active_thread;
    create unique index queue_items_active_thread
      on public.queue_items (thread_id)
      where is_split_clone = false
        and state in ('new','needs_attention','snoozed','awaiting_reply','backlog','fyi');
  end if;
end $$;

-- Live production contains these exclusions. Repo migration 0009 predates the
-- live skip_auto_rule_for_variable_senders hotfix.
create or replace function public.recategorize_queue_item(
  p_queue_item_id uuid,
  p_category text,
  p_business_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
begin
  select user_id, sender_identifier, channel
  into v_item
  from queue_items
  where id = p_queue_item_id and user_id = auth.uid();

  if not found then
    raise exception 'queue item not found';
  end if;

  update queue_items
  set category = p_category,
      business_id = p_business_id,
      updated_at = now()
  where id = p_queue_item_id;

  if v_item.channel = 'email'
     and v_item.sender_identifier is not null
     and v_item.sender_identifier <> ''
     and lower(v_item.sender_identifier) not like '%amazon%'
     and lower(v_item.sender_identifier) not like '%walmart%'
     and lower(v_item.sender_identifier) not like '%samsclub%'
  then
    insert into triage_rules
      (user_id, rule_type, pattern, business_id, category, source, enabled)
    values
      (auth.uid(), 'from_email', lower(v_item.sender_identifier),
       p_business_id, p_category, 'user', true)
    on conflict (user_id, rule_type, pattern)
    do update set
      business_id = excluded.business_id,
      category = excluded.category,
      enabled = true;
  end if;
end;
$$;

-- Preserve the existing application-callable behavior established by 0009.
grant execute on function public.recategorize_queue_item(uuid, text, uuid) to authenticated;

commit;
