// Code-enforced QC gates for the three pipeline stages.
//
// Each skill spec defines "Quality-control gates" describing when the stage
// FAILS QC. The model also self-reports qc_status, but that self-report is
// recorded only — these functions are the actual gate. Every check below maps
// to a bullet in the corresponding spec section; checks that cannot be decided
// mechanically are implemented as conservative heuristics and say so.

import type { PerplexityOutput } from "./perplexity.ts";
import type { PersonaOutput } from "./persona.ts";
import type { CommOutput } from "./comm.ts";

export interface QcResult {
  passed: boolean;
  fail_reasons: string[];
}

const HANDOFF_MAX_CHARS = 6000; // "handoff packet is bloated" gate

// ---------------------------------------------------------------- stage 1

export function qcPerplexity(out: PerplexityOutput): QcResult {
  const fails: string[] = [];

  // "identity resolution is weak but treated as strong"
  const idStatus = out.identity_resolution.status;
  if (
    (idStatus === "weak" || idStatus === "unresolved") &&
    out.handoff_packet.allowed_strategy_zone === "green"
  ) {
    fails.push(
      `identity_resolution is '${idStatus}' but allowed_strategy_zone is 'green' (weak identity treated as strong)`,
    );
  }
  if (
    (idStatus === "weak" || idStatus === "unresolved") &&
    out.identity_resolution.matched_profiles.some((p) => p.confidence === "green")
  ) {
    fails.push(
      "identity_resolution is weak/unresolved but a matched profile claims green confidence",
    );
  }

  // "any signal lacks evidence references" (label 'unknown' is exempt — an
  // unknown is by definition not an evidenced claim)
  for (const s of out.observable_signals) {
    if (s.label !== "unknown" && s.evidence_refs.length === 0) {
      fails.push(`observable signal without evidence_refs: "${s.signal}"`);
    }
    // "confidence bands are missing or misapplied": a hypothesis cannot be green
    if (s.label === "hypothesis" && s.confidence === "green") {
      fails.push(
        `hypothesis marked green confidence (band misapplied): "${s.signal}"`,
      );
    }
  }

  // "drift is speculative rather than observable"
  if (out.drift_tracking.drift_status !== "none") {
    if (out.drift_tracking.drift_signals.length === 0) {
      fails.push("drift_status is not 'none' but drift_signals is empty (speculative drift)");
    }
    for (const d of out.drift_tracking.drift_signals) {
      if (d.evidence_refs.length === 0) {
        fails.push(`drift signal without evidence_refs: "${d.signal}"`);
      }
    }
  }

  // "the handoff packet is bloated or includes unnecessary raw excerpts"
  const handoffSize = JSON.stringify(out.handoff_packet).length;
  if (handoffSize > HANDOFF_MAX_CHARS) {
    fails.push(`handoff_packet is bloated (${handoffSize} chars > ${HANDOFF_MAX_CHARS})`);
  }
  if (out.handoff_packet.top_signals.length > 12) {
    fails.push("handoff_packet.top_signals exceeds compact limit (12)");
  }

  return { passed: fails.length === 0, fail_reasons: fails };
}

// ---------------------------------------------------------------- stage 2

export function qcPersona(out: PersonaOutput): QcResult {
  const fails: string[] = [];

  // "any friction risk lacks observable_basis"
  for (const r of out.friction_risks) {
    if (!r.observable_basis.trim()) {
      fails.push(`friction risk without observable_basis: "${r.risk}"`);
    }
    // Friction-risk refinement rules: mitigation path + trigger conditions required
    if (r.mitigation.length === 0) {
      fails.push(`friction risk without mitigation path: "${r.risk}"`);
    }
    if (r.trigger_conditions.length === 0) {
      fails.push(`friction risk without trigger_conditions: "${r.risk}"`);
    }
  }

  // "a hypothesis appears inside stable_preferences" — mechanical checks:
  // stable preferences must be evidence-backed (schema already restricts the
  // band to green|yellow), and must not duplicate a motivator hypothesis.
  const hypotheses = new Set(
    out.motivator_hypotheses.map((h) => h.hypothesis.trim().toLowerCase()),
  );
  for (const p of out.stable_preferences) {
    if (p.evidence_refs.length === 0) {
      fails.push(`stable preference without evidence_refs: "${p.preference}"`);
    }
    if (hypotheses.has(p.preference.trim().toLowerCase())) {
      fails.push(`hypothesis appears inside stable_preferences: "${p.preference}"`);
    }
  }

  // "any field uses evidence-free certainty language" — mechanical proxy:
  // every green-band claim must carry evidence refs.
  for (const c of out.communication_relevance_map) {
    if (c.confidence === "green" && c.evidence_refs.length === 0) {
      fails.push(`green-band relevance signal without evidence_refs: "${c.signal}"`);
    }
    if (c.label === "hypothesis" && c.confidence === "green") {
      fails.push(`hypothesis marked green in communication_relevance_map: "${c.signal}"`);
    }
  }
  for (const s of out.probable_style_patterns) {
    if (s.confidence === "green" && s.evidence_refs.length === 0) {
      fails.push(`green-band style pattern without evidence_refs: "${s.pattern}"`);
    }
  }
  for (const l of out.rapport_levers) {
    if (l.confidence === "green" && l.evidence_refs.length === 0) {
      fails.push(`green-band rapport lever without evidence_refs: "${l.lever}"`);
    }
  }

  // Drift object integrity (shared drift rules: observable change only)
  if (out.drift_tracking.drift_status !== "none") {
    for (const d of out.drift_tracking.drift_signals) {
      if (d.evidence_refs.length === 0) {
        fails.push(`drift signal without evidence_refs: "${d.signal}"`);
      }
    }
  }

  // Handoff compactness (downstream contract: no full evidence corpus)
  const handoffSize = JSON.stringify(out.claude_handoff_packet).length;
  if (handoffSize > HANDOFF_MAX_CHARS) {
    fails.push(`claude_handoff_packet is bloated (${handoffSize} chars > ${HANDOFF_MAX_CHARS})`);
  }

  return { passed: fails.length === 0, fail_reasons: fails };
}

// ---------------------------------------------------------------- stage 3

// "interpretation rules use certainty language unsupported by band level" —
// the spec's field_rules require bounded language like "possible, plausible,
// insufficient signal" for non-green interpretations.
const BOUNDED_LANGUAGE =
  /\b(possible|possibly|plausib|insufficient|may\b|might\b|could\b|uncertain|unclear|likely|appears|suggest)/i;

// "a repair move increases pressure in a Yellow or Red case" — conservative
// pressure-language heuristic.
const PRESSURE_LANGUAGE =
  /\b(immediately|urgent|urgently|demand|insist|ultimatum|final notice|must respond|respond now|last chance|deadline)\b/i;

export function qcComm(
  out: CommOutput,
  upstream: { allowed_strategy_zone: "green" | "yellow" | "red"; drift_status: string },
): QcResult {
  const fails: string[] = [];

  // "any blueprint depends on Red-band material" — schema restricts blueprint
  // confidence to green|yellow; additionally, a red upstream zone permits NO
  // blueprints at all (red allowed_actions: do_not_operationalize).
  if (upstream.allowed_strategy_zone === "red") {
    if (out.message_blueprints.length > 0) {
      fails.push("upstream allowed_strategy_zone is red but message_blueprints are present");
    }
    if (out.opening_options.length > 0) {
      fails.push("upstream allowed_strategy_zone is red but opening_options are present");
    }
    if (out.human_review_flags.length === 0) {
      fails.push("red-zone strategy without human_review_flags (escalate_to_human_review required)");
    }
  }
  if (upstream.allowed_strategy_zone === "yellow") {
    // "treat Yellow material as Green" is not allowed: green-confidence
    // blueprints cannot exist when the whole zone is yellow.
    for (const b of out.message_blueprints) {
      if (b.confidence === "green") {
        fails.push(`yellow upstream zone but blueprint claims green confidence: "${b.blueprint_name}"`);
      }
    }
  }

  // "drift exists upstream but no drift_response_rules appear"
  if (upstream.drift_status !== "none") {
    if (out.drift_response_rules.drift_status === "none") {
      fails.push(
        `upstream drift_status is '${upstream.drift_status}' but drift_response_rules.drift_status is 'none'`,
      );
    }
    if (out.drift_response_rules.strategy_adjustment.length === 0) {
      fails.push("upstream drift present but drift_response_rules.strategy_adjustment is empty");
    }
  }

  // "interpretation rules use certainty language unsupported by band level"
  for (const r of out.response_interpretation_rules) {
    if (r.confidence !== "green" && !BOUNDED_LANGUAGE.test(r.bounded_interpretation)) {
      fails.push(
        `non-green interpretation lacks bounded language ("possible/plausible/insufficient signal"): "${r.observed_response_type}"`,
      );
    }
  }

  // "a repair move increases pressure in a Yellow or Red case"
  if (upstream.allowed_strategy_zone !== "green") {
    for (const m of out.repair_moves) {
      if (PRESSURE_LANGUAGE.test(m.move)) {
        fails.push(`repair move uses pressure language in a ${upstream.allowed_strategy_zone} case: "${m.scenario}"`);
      }
    }
  }

  return { passed: fails.length === 0, fail_reasons: fails };
}
