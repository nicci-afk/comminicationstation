// Stage 1 — perplexity_research_v1 contract, transcribed field-for-field from
// docs/skills/perplexity_research_skill_communication.md. Do not simplify.

import { z } from "zod";
import {
  ConfidenceBand,
  Contradiction,
  DriftTracking,
  QcStatus,
  StakesLevel,
} from "./confidence.ts";

export const PERPLEXITY_PROMPT_ID = "perplexity_research_v1";
export const PERPLEXITY_INPUT_SCHEMA_VERSION = "perplexity_input_v1";
export const PERPLEXITY_OUTPUT_SCHEMA_VERSION = "perplexity_output_v1";

export const PERPLEXITY_REQUIRED_OUTPUT_FIELDS = [
  "prompt_id",
  "output_schema_version",
  "source_profile_id",
  "identity_resolution",
  "coverage_map",
  "observable_signals",
  "contradictions",
  "drift_tracking",
  "uncertainty_map",
  "green_actions",
  "yellow_actions",
  "red_actions",
  "minimum_safe_next_action",
  "why_not_higher_confidence",
  "handoff_packet",
  "qc_status",
] as const;

export const PerplexityKnownIdentifiers = z.object({
  full_name: z.string(),
  aliases: z.array(z.string()),
  profile_urls: z.array(z.string()),
  location: z.array(z.string()),
  employer: z.array(z.string()),
  industry: z.array(z.string()),
});

export const PerplexityInput = z.object({
  prompt_id: z.literal(PERPLEXITY_PROMPT_ID),
  input_schema_version: z.literal(PERPLEXITY_INPUT_SCHEMA_VERSION),
  source_profile_id: z.string(),
  target_label: z.string(),
  known_identifiers: PerplexityKnownIdentifiers,
  use_case: z.string(),
  relationship_context: z.string(),
  stakes_level: StakesLevel,
  time_window: z.string(),
  signal_priorities: z.array(z.string()),
  confidence_rule_set: z.record(z.unknown()),
  schema_packet: z.object({
    input_schema_version: z.literal(PERPLEXITY_INPUT_SCHEMA_VERSION),
    expected_output_schema_version: z.literal(PERPLEXITY_OUTPUT_SCHEMA_VERSION),
    required_output_fields: z.array(z.string()),
    field_rules: z.record(z.string()),
  }),
  safety_policy_ref: z.string(),
  // Optional inputs per spec
  known_user_goal: z.string().optional(),
  specific_questions: z.array(z.string()).optional(),
  do_not_search: z.array(z.string()).optional(),
  human_review_mode: z.enum(["strict", "normal", "minimal"]).optional(),
  max_search_depth: z.enum(["compact", "normal", "deep"]).optional(),
});
export type PerplexityInput = z.infer<typeof PerplexityInput>;

export const IdentityResolution = z.object({
  status: z.enum(["strong", "partial", "weak", "unresolved"]),
  matched_profiles: z.array(
    z.object({
      url: z.string(),
      match_basis: z.array(z.string()),
      confidence: ConfidenceBand,
    }),
  ),
  identity_risks: z.array(z.string()),
});

export const ObservableSignal = z.object({
  signal: z.string(),
  label: z.enum(["fact", "pattern", "hypothesis", "unknown"]),
  category: z.enum([
    "bio",
    "work",
    "interests",
    "communication",
    "social_behavior",
    "activity",
    "content_style",
    "network",
    "timing",
  ]),
  recency: z.string(),
  source_type: z.enum(["self_authored", "third_party", "directory", "media"]),
  confidence: ConfidenceBand,
  evidence_refs: z.array(z.string()),
});

export const PersonaHandoffPacket = z.object({
  handoff_version: z.literal("persona_handoff_v1"),
  identity_status: z.string(),
  top_signals: z.array(z.string()),
  top_contradictions: z.array(z.string()),
  drift_tracking: z.record(z.unknown()),
  uncertainty_map: z.array(z.string()),
  allowed_strategy_zone: ConfidenceBand,
});
export type PersonaHandoffPacket = z.infer<typeof PersonaHandoffPacket>;

export const PerplexityOutput = z.object({
  prompt_id: z.literal(PERPLEXITY_PROMPT_ID),
  output_schema_version: z.literal(PERPLEXITY_OUTPUT_SCHEMA_VERSION),
  source_profile_id: z.string(),
  identity_resolution: IdentityResolution,
  coverage_map: z.array(
    z.object({
      signal_category: z.string(),
      status: z.enum(["covered", "partial", "missing"]),
      notes: z.string(),
    }),
  ),
  observable_signals: z.array(ObservableSignal),
  contradictions: z.array(Contradiction),
  drift_tracking: DriftTracking,
  uncertainty_map: z.array(
    z.object({
      unknown: z.string(),
      why_it_matters: z.string(),
      recommended_resolution: z.string(),
    }),
  ),
  green_actions: z.array(z.string()),
  yellow_actions: z.array(z.string()),
  red_actions: z.array(z.string()),
  minimum_safe_next_action: z.string(),
  why_not_higher_confidence: z.array(z.string()),
  handoff_packet: PersonaHandoffPacket,
  qc_status: QcStatus,
});
export type PerplexityOutput = z.infer<typeof PerplexityOutput>;
