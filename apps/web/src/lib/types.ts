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
  expense_type: string | null;
  property_ids: string[] | null;
  is_split_clone: boolean;
  created_at: string;
  updated_at: string;
}

export interface Property {
  id: string;
  business_id: string;
  name: string;
  address: string | null;
  active: boolean;
  sort_order: number;
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

export type MccSection =
  | "NEEDS_YOU_NOW"
  | "NEXT"
  | "CHATGPT_CAN_HANDLE"
  | "WAITING_ON_OTHERS"
  | "BLOCKED"
  | "SAFE_TO_DEFER";

export interface MccTodayItem {
  user_id: string;
  section: MccSection;
  section_order: number;
  section_rank: number;
  effective_priority: number;
  priority_reasons: string[];
  critical_attention: boolean;
  obligation_id: string;
  type: "ACTION" | "WAITING" | "DEADLINE" | "DECISION" | "RISK" | "DISCREPANCY" | "PROMISE";
  title: string;
  state: string;
  risk_level: "RED" | "ORANGE" | "YELLOW" | "GREEN";
  execution_owner: "NICCI" | "CHATGPT" | "CHATGPT_PREP" | "OTHER" | "WAITING";
  due_at: string | null;
  due_kind: "HARD" | "SOFT" | null;
  waiting_on: string | null;
  waiting_since: string | null;
  follow_up_at: string | null;
  next_action: string | null;
  verification_state: "VERIFIED" | "PARTIALLY_VERIFIED" | "UNVERIFIED" | "CONFLICT" | "STALE";
  freshness_expires_at: string | null;
  project_id: string | null;
  project_title: string | null;
  project_health: "ON_TRACK" | "NEEDS_ATTENTION" | "AT_RISK" | null;
  project_health_method: "MANUAL" | "DERIVED" | null;
  project_health_reason: string | null;
  project_health_updated_at: string | null;
  business_id: string | null;
  is_overdue: boolean;
  hard_due_within_24h: boolean;
  due_within_24h: boolean;
  due_within_3d: boolean;
  due_within_7d: boolean;
  follow_up_due: boolean;
  is_stale: boolean;
  has_open_dependency: boolean;
  created_at: string;
  updated_at: string;
}

export interface ObligationSource {
  id: string;
  obligation_id: string;
  source_system: string;
  source_type: string | null;
  source_ref: string;
  source_url: string | null;
  source_timestamp: string | null;
  content_hash: string | null;
  claim_scope: string[];
  authoritative_claims: string[];
  evidence_role: "PRIMARY" | "SUPPORTING" | "CONTEXT";
  created_at: string;
}


export interface MccIntegrityStatus {
  user_id: string;
  active_obligations: number;
  conflicts: number;
  stale_items: number;
  obligations_without_sources: number;
  duplicate_source_refs: number;
  invalid_state_rows: number;
  last_audit_event_at: string | null;
  emergency_stop: boolean | null;
  emergency_stop_reason: string | null;
  automation_database_writes_enabled: boolean | null;
  automation_external_sends_enabled: boolean | null;
  automation_booking_changes_enabled: boolean | null;
  automation_financial_actions_enabled: boolean | null;
  last_reviewed_at: string | null;
  integrity_state: "HEALTHY" | "NEEDS_ATTENTION" | "FAILED" | "UNKNOWN";
}

export interface ProductionChangeReceipt {
  id: string;
  change_key: string;
  action_class: "RED";
  target_system: string;
  target_environment: string;
  requested_outcome: string;
  exact_change_ref: string;
  expected_impact: Record<string, unknown>;
  preflight_state: "PENDING" | "PASSED" | "FAILED" | "BLOCKED";
  approval_state: "NOT_REQUIRED" | "PENDING" | "APPROVED" | "REVOKED";
  approved_at: string | null;
  approved_by: string | null;
  execution_state: "NOT_STARTED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "UNKNOWN";
  executed_at: string | null;
  actual_impact: Record<string, unknown> | null;
  verification_state: "PENDING" | "VERIFIED" | "PARTIALLY_VERIFIED" | "FAILED" | "UNKNOWN" | "CONFLICT";
  verified_at: string | null;
  recovery_ref: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}


export interface ObligationEvent {
  id: number;
  obligation_id: string;
  event_type: string;
  actor_type: "NICCI" | "CHATGPT" | "SYSTEM" | "OTHER";
  actor_ref: string | null;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  reason: string | null;
  source_ref: string | null;
  created_at: string;
}

export type MccManualAction = "DONE" | "BLOCKED" | "WAITING" | "NEED_HELP" | "UNDO_LAST";

export interface MccManualActionInput {
  obligation_id: string;
  action: MccManualAction;
  reason?: string | null;
  waiting_on?: string | null;
  follow_up_at?: string | null;
}
