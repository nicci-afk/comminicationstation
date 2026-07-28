export interface Business {
  id: string;
  name: string;
  color: string;
  priority_weight: number;
  is_default: boolean;
}

export type QueueState =
  | "new" | "needs_attention" | "fyi" | "suppressed" | "backlog"
  | "snoozed" | "responded" | "dismissed" | "awaiting_reply";

export interface QueueItem {
  id: string;
  thread_id: string;
  contact_id: string | null;
  business_id: string | null;
  state: QueueState;
  category: string;
  priority: number;
  priority_reasons: string[];
  channel: "email" | "sms" | "whatsapp";
  title: string;
  preview: string;
  sender_name: string;
  sender_identifier: string;
  is_vip: boolean;
  message_count: number;
  resolved_at: string | null;
  snoozed_until: string | null;
  sla_due_at: string | null;
  follow_up_at: string | null;
  escalated: boolean;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  thread_id: string;
  direction: "inbound" | "outbound";
  channel: string;
  from_name: string;
  from_identifier: string;
  to_identifiers: string[];
  subject: string;
  snippet: string;
  body_text: string | null;
  sent_at: string;
}

export interface QueueEvent {
  id: number;
  from_state: string | null;
  to_state: string;
  actor: "system" | "user";
  reason: string;
  evidence: Record<string, unknown>;
  created_at: string;
}

export interface Contact {
  id: string;
  display_name: string;
  kind: "human" | "automated" | "organization" | "unknown";
  is_vip: boolean;
  notes: string;
  birthday: string | null;
  address: string | null;
  last_seen_at: string;
}

export interface ContactChannel {
  id: string;
  channel_type: "email" | "phone";
  raw_value: string;
  canonical_value: string;
}

export interface ContactStrategy {
  id: string;
  contact_id: string;
  business_id: string | null;
  channel: string;
  status: "active" | "stale" | "drift_flagged" | "superseded";
  allowed_zone: "green" | "yellow" | "red";
  drift_status: string;
  re_analysis_recommended: boolean;
  re_analysis_reason: string;
  comm_artifact_id: string | null;
  perplexity_artifact_id: string | null;
  persona_artifact_id: string | null;
  updated_at: string;
}

export interface PipelineRun {
  id: string;
  contact_id: string;
  status: string;
  current_stage: number;
  error: string | null;
  total_cost_usd: number;
  created_at: string;
  finished_at: string | null;
}

export interface GmailAccount {
  id: string;
  email_address: string;
  status: string;
  last_sync_at: string | null;
  watch_expiration: string | null;
  backfill_done: boolean;
  last_error: string | null;
  has_send_scope: boolean;
}

export interface Profile {
  user_id: string;
  email: string;
  display_name: string;
  timezone: string;
  digest_hour: number;
  digest_enabled: boolean;
}
