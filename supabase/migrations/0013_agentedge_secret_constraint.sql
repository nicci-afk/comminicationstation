-- Drop and recreate the user_secrets kind CHECK constraint to include agentedge_service_key.
alter table public.user_secrets
  drop constraint if exists user_secrets_kind_check;

alter table public.user_secrets
  add constraint user_secrets_kind_check check (kind in (
    'perplexity_api_key', 'openai_api_key', 'anthropic_api_key',
    'twilio_account_sid', 'twilio_auth_token', 'agentedge_service_key'
  ));
