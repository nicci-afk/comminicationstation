// Stage 3 — claude_communication_strategy_v1 contract, transcribed
// field-for-field from docs/skills/claude_communication_strategy_skill.md.
// Also defines interaction_update_v1 (post_interaction_update_packet), which is
// the ONLY mechanism for evolving a stored strategy without a pipeline re-run.

import { z } from "zod";
import {
  ConfidenceBand,
  DriftStatus,
  QcStatus,
  StakesLevel,
} from "./confidence.ts";

export const COMM_PROMPT_ID = "claude_communication_strategy_v1";
export const COMM_INPUT_SCHEMA_VERSION = "claude_comm_input_v1";
export const COMM_OUTPUT_SCHEMA_VERSION = "claude_comm_output_v1";
export const INTERACTION_UPDATE_SCHEMA_VERSION = "interaction_update_v1";

export const COMM_REQUIRED_OUTPUT_FIELDS = [
  "prompt_id",
  "output_schema_version",
  "source_profile_id",
  "channel_strategy",
  "tone_profile",
  "message_objective",
  "recommended_approach",
  "sequencing_plan",
  "language_do",
  "language_avoid",
  "opening_options",
  "message_blueprints",
  "repair_moves",
  "response_interpretation_rules",
  "next_step_matrix",
  "drift_response_rules",
  "post_interaction_update_packet",
  "human_review_flags",
  "minimum_safe_next_action",
  "why_not_higher_confidence",
  "qc_status",
] as const;

export const CommChannel = z.enum([
  "text",
  "dm",
  "email",
  "call",
  "in_person",
  "other",
]);

export const CommInput = z.object({
  prompt_id: z.literal(COMM_PROMPT_ID),
  input_schema_version: z.literal(COMM_INPUT_SCHEMA_VERSION),
  source_profile_id: z.string(),
  use_case: z.string(),
  desired_outcome: z.string(),
  relationship_context: z.string(),
  channel: CommChannel,
  stakes_level: StakesLevel,
  chatgpt_claude_handoff_packet: z.record(z.unknown()),
  confidence_rule_set: z.record(z.unknown()),
  schema_packet: z.object({
    input_schema_version: z.literal(COMM_INPUT_SCHEMA_VERSION),
    expected_output_schema_version: z.literal(COMM_OUTPUT_SCHEMA_VERSION),
    required_output_fields: z.array(z.string()),
    field_rules: z.record(z.string()),
  }),
  safety_policy_ref: z.string(),
  // Optional inputs per spec
  draft_message_from_user: z.string().optional(),
  timing_context: z.string().optional(),
  length_limit: z.string().optional(),
  tone_preferences: z.array(z.string()).optional(),
  hard_constraints: z.array(z.string()).optional(),
  reply_risk_tolerance: z.enum(["low", "medium", "high"]).optional(),
  fallback_goal: z.string().optional(),
});
export type CommInput = z.infer<typeof CommInput>;

export const PostInteractionUpdatePacket = z.object({
  update_schema_version: z.literal(INTERACTION_UPDATE_SCHEMA_VERSION),
  what_was_sent: z.string(),
  response_observed: z.string(),
  response_classification: z.string(),
  confidence_change: z.enum(["increase", "decrease", "none"]),
  friction_signals_observed: z.array(z.string()),
  drift_signals_observed: z.array(z.string()),
  recommended_upstream_updates: z.array(z.string()),
});
export type PostInteractionUpdatePacket = z.infer<
  typeof PostInteractionUpdatePacket
>;

export const MessageBlueprint = z.object({
  blueprint_name: z.string(),
  use_when: z.string(),
  template: z.string(),
  risk_notes: z.array(z.string()),
  confidence: z.enum(["green", "yellow"]),
});

export const CommOutput = z.object({
  prompt_id: z.literal(COMM_PROMPT_ID),
  output_schema_version: z.literal(COMM_OUTPUT_SCHEMA_VERSION),
  source_profile_id: z.string(),
  channel_strategy: z.object({
    channel: z.string(),
    length_guidance: z.string(),
    pacing_guidance: z.string(),
    follow_up_cadence: z.string(),
    constraints: z.array(z.string()),
  }),
  tone_profile: z.object({
    recommended_tone: z.array(z.string()),
    avoid_tone: z.array(z.string()),
    confidence: ConfidenceBand,
  }),
  message_objective: z.string(),
  recommended_approach: z.string(),
  sequencing_plan: z.array(
    z.object({
      step: z.number(),
      goal: z.string(),
      instruction: z.string(),
      confidence: ConfidenceBand,
    }),
  ),
  language_do: z.array(z.string()),
  language_avoid: z.array(z.string()),
  opening_options: z.array(
    z.object({
      option: z.string(),
      use_when: z.string(),
      confidence: z.enum(["green", "yellow"]),
    }),
  ),
  message_blueprints: z.array(MessageBlueprint),
  repair_moves: z.array(
    z.object({
      scenario: z.string(),
      repair_goal: z.string(),
      move: z.string(),
      do_not_do: z.array(z.string()),
    }),
  ),
  response_interpretation_rules: z.array(
    z.object({
      observed_response_type: z.string(),
      bounded_interpretation: z.string(),
      confidence: ConfidenceBand,
      recommended_next_step: z.string(),
    }),
  ),
  next_step_matrix: z.array(
    z.object({
      condition: z.string(),
      action: z.string(),
      review_needed: z.boolean(),
    }),
  ),
  drift_response_rules: z.object({
    drift_status: DriftStatus,
    strategy_adjustment: z.array(z.string()),
    must_confirm_before_proceeding: z.array(z.string()),
    review_trigger: z.boolean(),
  }),
  post_interaction_update_packet: PostInteractionUpdatePacket,
  human_review_flags: z.array(z.string()),
  minimum_safe_next_action: z.string(),
  why_not_higher_confidence: z.array(z.string()),
  qc_status: QcStatus,
});
export type CommOutput = z.infer<typeof CommOutput>;
