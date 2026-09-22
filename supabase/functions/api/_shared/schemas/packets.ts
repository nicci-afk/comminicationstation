// Input-packet builders for the three pipeline stages. Every packet embeds
// confidence_rules_v1 and the stage's schema_packet exactly as the specs
// require. The builders are the only place input packets are constructed.

import { CONFIDENCE_RULE_SET, SAFETY_POLICY_REF } from "./confidence.ts";
import {
  PERPLEXITY_INPUT_SCHEMA_VERSION,
  PERPLEXITY_OUTPUT_SCHEMA_VERSION,
  PERPLEXITY_PROMPT_ID,
  PERPLEXITY_REQUIRED_OUTPUT_FIELDS,
  PerplexityInput,
} from "./perplexity.ts";
import {
  PERSONA_INPUT_SCHEMA_VERSION,
  PERSONA_OUTPUT_SCHEMA_VERSION,
  PERSONA_PROMPT_ID,
  PERSONA_REQUIRED_OUTPUT_FIELDS,
  PersonaInput,
} from "./persona.ts";
import {
  COMM_INPUT_SCHEMA_VERSION,
  COMM_OUTPUT_SCHEMA_VERSION,
  COMM_PROMPT_ID,
  COMM_REQUIRED_OUTPUT_FIELDS,
  CommInput,
} from "./comm.ts";

export interface AnalyzeRequest {
  source_profile_id: string;
  target_label: string;
  full_name: string;
  aliases: string[];
  profile_urls: string[];
  location: string[];
  employer: string[];
  industry: string[];
  use_case: string;
  relationship_context: string;
  stakes_level: "low" | "medium" | "high";
  desired_outcome: string;
  channel: "text" | "dm" | "email" | "call" | "in_person" | "other";
  known_user_goal?: string;
  interaction_history_summary?: string;
  time_window?: string;
}

export function buildPerplexityInput(req: AnalyzeRequest): PerplexityInput {
  return PerplexityInput.parse({
    prompt_id: PERPLEXITY_PROMPT_ID,
    input_schema_version: PERPLEXITY_INPUT_SCHEMA_VERSION,
    source_profile_id: req.source_profile_id,
    target_label: req.target_label,
    known_identifiers: {
      full_name: req.full_name,
      aliases: req.aliases,
      profile_urls: req.profile_urls,
      location: req.location,
      employer: req.employer,
      industry: req.industry,
    },
    use_case: req.use_case,
    relationship_context: req.relationship_context,
    stakes_level: req.stakes_level,
    time_window: req.time_window ?? "last 24 months",
    signal_priorities: [
      "communication style and channel preferences",
      "professional role and current focus",
      "tone and formality patterns",
      "responsiveness and timing patterns",
      "public interests relevant to rapport",
    ],
    confidence_rule_set: CONFIDENCE_RULE_SET,
    schema_packet: {
      input_schema_version: PERPLEXITY_INPUT_SCHEMA_VERSION,
      expected_output_schema_version: PERPLEXITY_OUTPUT_SCHEMA_VERSION,
      required_output_fields: [...PERPLEXITY_REQUIRED_OUTPUT_FIELDS],
      field_rules: {
        observable_signals: "Must reflect only publicly observable evidence.",
        drift_tracking: "Must use observable change only, not personality speculation.",
        handoff_packet: "Must be compact and strategy-ready for downstream use.",
      },
    },
    safety_policy_ref: SAFETY_POLICY_REF,
    known_user_goal: req.known_user_goal,
    human_review_mode: "normal",
    max_search_depth: "normal",
  });
}

export function buildPersonaInput(
  req: AnalyzeRequest,
  perplexityHandoffPacket: Record<string, unknown>,
  evidenceCapsule: Record<string, unknown>,
): PersonaInput {
  return PersonaInput.parse({
    prompt_id: PERSONA_PROMPT_ID,
    input_schema_version: PERSONA_INPUT_SCHEMA_VERSION,
    source_profile_id: req.source_profile_id,
    target_label: req.target_label,
    use_case: req.use_case,
    relationship_context: req.relationship_context,
    stakes_level: req.stakes_level,
    perplexity_handoff_packet: perplexityHandoffPacket,
    evidence_capsule: evidenceCapsule,
    confidence_rule_set: CONFIDENCE_RULE_SET,
    schema_packet: {
      input_schema_version: PERSONA_INPUT_SCHEMA_VERSION,
      expected_output_schema_version: PERSONA_OUTPUT_SCHEMA_VERSION,
      required_output_fields: [...PERSONA_REQUIRED_OUTPUT_FIELDS],
      field_rules: {
        friction_risks: "Must be operational communication risks, not personality judgments.",
        drift_tracking: "Must use the shared drift object and cite only observable changes.",
        motivator_hypotheses: "Must remain hypotheses and never be framed as settled facts.",
      },
    },
    safety_policy_ref: SAFETY_POLICY_REF,
    known_user_goal: req.known_user_goal,
    interaction_history_summary: req.interaction_history_summary,
    human_review_mode: "normal",
  });
}

export function buildCommInput(
  req: AnalyzeRequest,
  claudeHandoffPacket: Record<string, unknown>,
): CommInput {
  return CommInput.parse({
    prompt_id: COMM_PROMPT_ID,
    input_schema_version: COMM_INPUT_SCHEMA_VERSION,
    source_profile_id: req.source_profile_id,
    use_case: req.use_case,
    desired_outcome: req.desired_outcome,
    relationship_context: req.relationship_context,
    channel: req.channel,
    stakes_level: req.stakes_level,
    chatgpt_claude_handoff_packet: claudeHandoffPacket,
    confidence_rule_set: CONFIDENCE_RULE_SET,
    schema_packet: {
      input_schema_version: COMM_INPUT_SCHEMA_VERSION,
      expected_output_schema_version: COMM_OUTPUT_SCHEMA_VERSION,
      required_output_fields: [...COMM_REQUIRED_OUTPUT_FIELDS],
      field_rules: {
        message_blueprints: "Must stay within allowed strategy zone from upstream handoff.",
        drift_response_rules: "Must adapt to upstream drift_tracking without inventing causes.",
        response_interpretation_rules: "Must use bounded language like possible, plausible, insufficient signal.",
      },
    },
    safety_policy_ref: SAFETY_POLICY_REF,
    reply_risk_tolerance: "low",
  });
}
