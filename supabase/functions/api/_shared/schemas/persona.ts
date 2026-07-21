// Stage 2 — chatgpt_persona_strategy_v1 contract, transcribed field-for-field
// from docs/skills/chatgpt_persona_strategy_skill_communication.md. Do not simplify.

import { z } from "zod";
import {
  ConfidenceBand,
  Contradiction,
  DriftTracking,
  QcStatus,
  StakesLevel,
} from "./confidence.ts";

export const PERSONA_PROMPT_ID = "chatgpt_persona_strategy_v1";
export const PERSONA_INPUT_SCHEMA_VERSION = "chatgpt_persona_input_v1";
export const PERSONA_OUTPUT_SCHEMA_VERSION = "chatgpt_persona_output_v1";

export const PERSONA_REQUIRED_OUTPUT_FIELDS = [
  "prompt_id",
  "output_schema_version",
  "source_profile_id",
  "persona_scope",
  "evidence_used_summary",
  "communication_relevance_map",
  "stable_preferences",
  "probable_style_patterns",
  "motivator_hypotheses",
  "friction_risks",
  "drift_tracking",
  "rapport_levers",
  "do_not_assume",
  "unknowns_that_matter",
  "contradictions_to_watch",
  "green_actions",
  "yellow_actions",
  "red_actions",
  "minimum_safe_next_action",
  "why_not_higher_confidence",
  "claude_handoff_packet",
  "qc_status",
] as const;

export const PersonaInput = z.object({
  prompt_id: z.literal(PERSONA_PROMPT_ID),
  input_schema_version: z.literal(PERSONA_INPUT_SCHEMA_VERSION),
  source_profile_id: z.string(),
  target_label: z.string(),
  use_case: z.string(),
  relationship_context: z.string(),
  stakes_level: StakesLevel,
  perplexity_handoff_packet: z.record(z.unknown()),
  evidence_capsule: z.record(z.unknown()),
  confidence_rule_set: z.record(z.unknown()),
  schema_packet: z.object({
    input_schema_version: z.literal(PERSONA_INPUT_SCHEMA_VERSION),
    expected_output_schema_version: z.literal(PERSONA_OUTPUT_SCHEMA_VERSION),
    required_output_fields: z.array(z.string()),
    field_rules: z.record(z.string()),
  }),
  safety_policy_ref: z.string(),
  // Optional inputs per spec
  known_user_goal: z.string().optional(),
  interaction_history_summary: z.string().optional(),
  channel_constraints: z.array(z.string()).optional(),
  tone_constraints: z.array(z.string()).optional(),
  time_horizon: z.string().optional(),
  red_lines: z.array(z.string()).optional(),
  human_review_mode: z.enum(["strict", "normal", "minimal"]).optional(),
});
export type PersonaInput = z.infer<typeof PersonaInput>;

export const FrictionRisk = z.object({
  risk: z.string(),
  risk_type: z.enum([
    "tone_mismatch",
    "pacing_mismatch",
    "ambiguity",
    "overreach",
    "credibility_loss",
    "boundary_violation",
    "inconsistency_trigger",
    "channel_mismatch",
    "timing_mismatch",
  ]),
  trigger_conditions: z.array(z.string()),
  observable_basis: z.string(),
  impact_if_missed: z.string(),
  mitigation: z.array(z.string()),
  confidence: ConfidenceBand,
  evidence_refs: z.array(z.string()),
});

export const ClaudeHandoffPacket = z.object({
  handoff_version: z.literal("claude_handoff_v1"),
  persona_summary: z.string(),
  top_friction_risks: z.array(z.string()),
  top_rapport_levers: z.array(z.string()),
  drift_tracking: z.record(z.unknown()),
  allowed_strategy_zone: ConfidenceBand,
  message_constraints: z.array(z.string()),
  unknowns_that_matter: z.array(z.string()),
});
export type ClaudeHandoffPacket = z.infer<typeof ClaudeHandoffPacket>;

export const PersonaOutput = z.object({
  prompt_id: z.literal(PERSONA_PROMPT_ID),
  output_schema_version: z.literal(PERSONA_OUTPUT_SCHEMA_VERSION),
  source_profile_id: z.string(),
  persona_scope: z.string(),
  evidence_used_summary: z.string(),
  communication_relevance_map: z.array(
    z.object({
      signal: z.string(),
      label: z.enum(["fact", "pattern", "hypothesis", "unknown"]),
      why_it_matters: z.string(),
      confidence: ConfidenceBand,
      evidence_refs: z.array(z.string()),
    }),
  ),
  stable_preferences: z.array(
    z.object({
      preference: z.string(),
      confidence: z.enum(["green", "yellow"]),
      basis: z.string(),
      evidence_refs: z.array(z.string()),
    }),
  ),
  probable_style_patterns: z.array(
    z.object({
      pattern: z.string(),
      confidence: z.enum(["green", "yellow"]),
      conditions: z.array(z.string()),
      evidence_refs: z.array(z.string()),
    }),
  ),
  motivator_hypotheses: z.array(
    z.object({
      hypothesis: z.string(),
      confidence: z.enum(["yellow", "red"]),
      reason: z.string(),
      evidence_refs: z.array(z.string()),
    }),
  ),
  friction_risks: z.array(FrictionRisk),
  drift_tracking: DriftTracking,
  rapport_levers: z.array(
    z.object({
      lever: z.string(),
      safe_usage_note: z.string(),
      confidence: z.enum(["green", "yellow"]),
      evidence_refs: z.array(z.string()),
    }),
  ),
  do_not_assume: z.array(z.string()),
  unknowns_that_matter: z.array(z.string()),
  contradictions_to_watch: z.array(Contradiction),
  green_actions: z.array(z.string()),
  yellow_actions: z.array(z.string()),
  red_actions: z.array(z.string()),
  minimum_safe_next_action: z.string(),
  why_not_higher_confidence: z.array(z.string()),
  claude_handoff_packet: ClaudeHandoffPacket,
  qc_status: QcStatus,
});
export type PersonaOutput = z.infer<typeof PersonaOutput>;
