-- Add agentedge_service_key to the allowed kinds in set_user_secret.
create or replace function public.set_user_secret(p_kind text, p_value text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;
  if p_kind not in ('perplexity_api_key','openai_api_key','anthropic_api_key',
                    'twilio_account_sid','twilio_auth_token','agentedge_service_key') then
    raise exception 'unknown secret kind %', p_kind;
  end if;
  if length(trim(p_value)) < 8 then
    raise exception 'secret value too short';
  end if;
  v_id := public.vault_upsert_secret('user:' || v_user || ':' || p_kind, trim(p_value));
  insert into public.user_secrets (user_id, kind, vault_secret_id)
  values (v_user, p_kind, v_id)
  on conflict (user_id, kind)
  do update set vault_secret_id = excluded.vault_secret_id, updated_at = now();
end;
$$;
