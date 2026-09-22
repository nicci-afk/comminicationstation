// confidence_rules_v1 — embedded verbatim from the three skill specs.
// This object is included in EVERY pipeline stage input packet, as the specs require.
// Do not edit without bumping the version and updating all three stage contracts.

import { z } from "zod";

export const ConfidenceBand = z.enum(["green", "yellow", "red"]);
export type ConfidenceBand = z.infer<typeof ConfidenceBand>;

export const CONFIDENCE_RULE_SET = {
  version: "confidence_rules_v1",
  bands: {
    green: {
      meaning:
        "supported by repeated, recent, direct, communication-relevant evidence",
      allowed_actions: [
        "use_in_low-risk_strategy",
        "mention_as_likely_preference",
        "optimize_tone_or_format",
      ],
    },
    yellow: {
      meaning: "partially supported, limited, mixed, stale, or indirect evidence",
      allowed_actions: [
        "use_cautiously",
        "frame_as_possible",
        "seek_confirmation",
        "prepare_alternative_paths",
      ],
    },
    red: {
      meaning: "insufficient, contradictory, high-risk, or disallowed inference",
      allowed_actions: [
        "do_not_operationalize",
        "escalate_to_human_review",
        "mark_unknown",
      ],
    },
  },
  promotion_rules: [
    "Do not promote hypothesis to pattern without at least two independent observable signals.",
    "Do not promote pattern to stable preference without repeat evidence across time or contexts.",
    "Recency outranks volume when signals conflict.",
    "Self-authored signals outrank third-party summaries.",
  ],
  suppression_rules: [
    "Do not infer sensitive traits or protected-class attributes.",
    "Do not infer internal emotional state as fact.",
    "Do not build strategy from one-off novelty signals.",
    "Do not operationalize contradicted evidence without explicit caution labeling.",
  ],
  review_triggers: [
    "identity_resolution_weak",
    "contradiction_rate_high",
    "drift_detected",
    "stakes_high",
    "red_band_dependency",
  ],
} as const;

export const StakesLevel = z.enum(["low", "medium", "high"]);
export type StakesLevel = z.infer<typeof StakesLevel>;

// Shared drift object used by all three stages (identical shape in the
// perplexity and persona output schemas; claude consumes it via handoff).
export const DriftStatus = z.enum(["none", "possible", "active", "unresolved"]);

export const DriftSignal = z.object({
  signal: z.string(),
  direction: z.enum(["increase", "decrease", "shift", "inconsistency"]),
  confidence: ConfidenceBand,
  evidence_refs: z.array(z.string()),
});

export const DriftTracking = z.object({
  drift_status: DriftStatus,
  drift_window: z.string(),
  drift_signals: z.array(DriftSignal),
  drift_impact: z.array(z.string()),
  recommended_response: z.enum(["hold", "adapt", "confirm", "escalate"]),
  requires_human_review: z.boolean(),
});
export type DriftTracking = z.infer<typeof DriftTracking>;

export const QcStatus = z.object({
  passed: z.boolean(),
  fail_reasons: z.array(z.string()),
});

export const Contradiction = z.object({
  topic: z.string(),
  conflict_summary: z.string(),
  operational_effect: z.string(),
});

export const SAFETY_POLICY_REF = "default_safety_policy_v1";
