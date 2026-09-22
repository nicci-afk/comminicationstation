-- Track whether a connected Gmail account has the gmail.send scope granted.
-- Defaults to false for all existing accounts; set to true on re-auth with the
-- upgraded scope list. The UI and gmail-send edge function gate on this flag.
alter table public.gmail_accounts
  add column if not exists has_send_scope boolean not null default false;
