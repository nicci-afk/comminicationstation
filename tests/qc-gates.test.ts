// Exercises the EXACT schema + QC-gate code deployed in the pipeline worker.
// Run from the repo root:  npm install --no-save zod tsx && npx tsx tests/qc-gates.test.ts
// Exits non-zero on any failure.
import { PerplexityOutput } from "../supabase/functions/api/_shared/schemas/perplexity.ts";
import { PersonaOutput } from "../supabase/functions/api/_shared/schemas/persona.ts";
import { CommOutput, PostInteractionUpdatePacket } from "../supabase/functions/api/_shared/schemas/comm.ts";
import { qcComm, qcPerplexity, qcPersona } from "../supabase/functions/api/_shared/schemas/qc.ts";
import { buildPerplexityInput, buildPersonaInput, buildCommInput } from "../supabase/functions/api/_shared/schemas/packets.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

const drift = {
  drift_status: "none", drift_window: "24 months", drift_signals: [],
  drift_impact: [], recommended_response: "hold", requires_human_review: false,
};
const qcOk = { passed: true, fail_reasons: [] };

// ---------- Stage 1
const validPerplexity = {
  prompt_id: "perplexity_research_v1", output_schema_version: "perplexity_output_v1",
  source_profile_id: "contact-1",
  identity_resolution: {
    status: "strong",
    matched_profiles: [{ url: "https://linkedin.com/in/x", match_basis: ["name+employer"], confidence: "green" }],
    identity_risks: [],
  },
  coverage_map: [{ signal_category: "communication", status: "covered", notes: "recent posts" }],
  observable_signals: [{
    signal: "writes short direct emails", label: "pattern", category: "communication",
    recency: "2026-06", source_type: "self_authored", confidence: "green",
    evidence_refs: ["https://example.com/a", "https://example.com/b"],
  }],
  contradictions: [], drift_tracking: drift,
  uncertainty_map: [{ unknown: "preferred channel", why_it_matters: "affects pacing", recommended_resolution: "observe replies" }],
  green_actions: ["match concise tone"], yellow_actions: [], red_actions: [],
  minimum_safe_next_action: "reply concisely and confirm scope",
  why_not_higher_confidence: ["limited public volume"],
  handoff_packet: {
    handoff_version: "persona_handoff_v1", identity_status: "strong",
    top_signals: ["concise, direct communicator"], top_contradictions: [],
    drift_tracking: drift, uncertainty_map: ["preferred channel"], allowed_strategy_zone: "green",
  },
  qc_status: qcOk,
};
console.log("Stage 1 — perplexity_output_v1:");
{
  const z = PerplexityOutput.safeParse(validPerplexity);
  check("valid fixture passes zod", z.success);
  check("valid fixture passes QC gates", z.success && qcPerplexity(z.data).passed);

  const weakGreen = structuredClone(validPerplexity);
  weakGreen.identity_resolution.status = "weak";
  const r1 = qcPerplexity(PerplexityOutput.parse(weakGreen));
  check("weak identity + green zone FAILS QC", !r1.passed, JSON.stringify(r1.fail_reasons));

  const noEvidence = structuredClone(validPerplexity);
  noEvidence.observable_signals[0].evidence_refs = [];
  const r2 = qcPerplexity(PerplexityOutput.parse(noEvidence));
  check("signal without evidence_refs FAILS QC", !r2.passed);

  const specDrift = structuredClone(validPerplexity);
  specDrift.drift_tracking = { ...drift, drift_status: "possible", drift_signals: [] };
  const r3 = qcPerplexity(PerplexityOutput.parse(specDrift));
  check("speculative drift (no signals) FAILS QC", !r3.passed);

  const badEnum = structuredClone(validPerplexity) as Record<string, unknown>;
  (badEnum.identity_resolution as Record<string, unknown>).status = "certain";
  check("invalid enum REJECTED by zod", !PerplexityOutput.safeParse(badEnum).success);
}

// ---------- Stage 2
const validPersona = {
  prompt_id: "chatgpt_persona_strategy_v1", output_schema_version: "chatgpt_persona_output_v1",
  source_profile_id: "contact-1", persona_scope: "professional correspondence",
  evidence_used_summary: "handoff packet + capsule of 1 signal",
  communication_relevance_map: [{
    signal: "concise emails", label: "pattern", why_it_matters: "match brevity",
    confidence: "green", evidence_refs: ["https://example.com/a"],
  }],
  stable_preferences: [{ preference: "brevity", confidence: "green", basis: "repeated self-authored posts", evidence_refs: ["https://example.com/a"] }],
  probable_style_patterns: [{ pattern: "bullet lists", confidence: "yellow", conditions: ["longer topics"], evidence_refs: ["https://example.com/b"] }],
  motivator_hypotheses: [{ hypothesis: "values efficiency", confidence: "yellow", reason: "style consistency", evidence_refs: ["https://example.com/a"] }],
  friction_risks: [{
    risk: "long intros lose attention", risk_type: "pacing_mismatch",
    trigger_conditions: ["multi-paragraph opener"], observable_basis: "short replies to long emails",
    impact_if_missed: "delayed responses", mitigation: ["lead with the ask"],
    confidence: "yellow", evidence_refs: ["https://example.com/b"],
  }],
  drift_tracking: drift,
  rapport_levers: [{ lever: "acknowledge their timeline", safe_usage_note: "only when real", confidence: "yellow", evidence_refs: ["https://example.com/a"] }],
  do_not_assume: ["decision authority"], unknowns_that_matter: ["budget cycle"],
  contradictions_to_watch: [], green_actions: ["be concise"], yellow_actions: ["confirm channel"], red_actions: [],
  minimum_safe_next_action: "send a concise confirmation",
  why_not_higher_confidence: ["single-channel evidence"],
  claude_handoff_packet: {
    handoff_version: "claude_handoff_v1", persona_summary: "concise, efficiency-minded professional",
    top_friction_risks: ["long intros"], top_rapport_levers: ["timeline acknowledgement"],
    drift_tracking: drift, allowed_strategy_zone: "green",
    message_constraints: ["keep under 150 words"], unknowns_that_matter: ["budget cycle"],
  },
  qc_status: qcOk,
};
console.log("Stage 2 — chatgpt_persona_output_v1:");
{
  const z = PersonaOutput.safeParse(validPersona);
  check("valid fixture passes zod", z.success);
  check("valid fixture passes QC gates", z.success && qcPersona(z.data).passed);

  const noBasis = structuredClone(validPersona);
  noBasis.friction_risks[0].observable_basis = "  ";
  check("friction risk without observable_basis FAILS QC", !qcPersona(PersonaOutput.parse(noBasis)).passed);

  const greenHypo = structuredClone(validPersona) as Record<string, unknown>;
  (greenHypo.motivator_hypotheses as Record<string, unknown>[])[0].confidence = "green";
  check("green motivator hypothesis REJECTED by zod (yellow|red only)", !PersonaOutput.safeParse(greenHypo).success);

  const hypoInPrefs = structuredClone(validPersona);
  hypoInPrefs.stable_preferences[0].preference = "values efficiency";
  check("hypothesis duplicated into stable_preferences FAILS QC", !qcPersona(PersonaOutput.parse(hypoInPrefs)).passed);
}

// ---------- Stage 3
const validComm = {
  prompt_id: "claude_communication_strategy_v1", output_schema_version: "claude_comm_output_v1",
  source_profile_id: "contact-1",
  channel_strategy: { channel: "email", length_guidance: "under 150 words", pacing_guidance: "reply within a day", follow_up_cadence: "nudge after 4 days", constraints: ["no jargon"] },
  tone_profile: { recommended_tone: ["warm", "direct"], avoid_tone: ["formal"], confidence: "green" },
  message_objective: "confirm the October dates",
  recommended_approach: "lead with the decision needed",
  sequencing_plan: [{ step: 1, goal: "confirm dates", instruction: "state the two options", confidence: "green" }],
  language_do: ["short sentences"], language_avoid: ["vague timelines"],
  opening_options: [{ option: "Quick one on the October dates —", use_when: "active thread", confidence: "green" }],
  message_blueprints: [{ blueprint_name: "date-confirm", use_when: "awaiting decision", template: "Hi {name}, quick one: {question}", risk_notes: [], confidence: "green" }],
  repair_moves: [{ scenario: "no response after nudge", repair_goal: "reopen gently", move: "offer a shorter path to a decision", do_not_do: ["stack multiple asks"] }],
  response_interpretation_rules: [
    { observed_response_type: "short confirmation", bounded_interpretation: "likely agreement", confidence: "green", recommended_next_step: "proceed to contract" },
    { observed_response_type: "silence for a week", bounded_interpretation: "insufficient signal to conclude disinterest", confidence: "yellow", recommended_next_step: "one gentle nudge" },
  ],
  next_step_matrix: [{ condition: "dates confirmed", action: "send contract", review_needed: false }],
  drift_response_rules: { drift_status: "none", strategy_adjustment: [], must_confirm_before_proceeding: [], review_trigger: false },
  post_interaction_update_packet: {
    update_schema_version: "interaction_update_v1", what_was_sent: "", response_observed: "", response_classification: "",
    confidence_change: "none", friction_signals_observed: [], drift_signals_observed: [], recommended_upstream_updates: [],
  },
  human_review_flags: [], minimum_safe_next_action: "send the date-confirm blueprint",
  why_not_higher_confidence: ["no in-person history"], qc_status: qcOk,
};
console.log("Stage 3 — claude_comm_output_v1:");
{
  const z = CommOutput.safeParse(validComm);
  check("valid fixture passes zod", z.success);
  check("valid passes QC under green upstream", z.success && qcComm(z.data, { allowed_strategy_zone: "green", drift_status: "none" }).passed);

  const r1 = qcComm(CommOutput.parse(validComm), { allowed_strategy_zone: "red", drift_status: "none" });
  check("blueprints under RED upstream zone FAIL QC", !r1.passed, JSON.stringify(r1.fail_reasons));

  const r2 = qcComm(CommOutput.parse(validComm), { allowed_strategy_zone: "yellow", drift_status: "none" });
  check("green-confidence blueprint under YELLOW zone FAILS QC", !r2.passed);

  const r3 = qcComm(CommOutput.parse(validComm), { allowed_strategy_zone: "green", drift_status: "possible" });
  check("upstream drift without drift_response_rules FAILS QC", !r3.passed);

  const pressure = structuredClone(validComm);
  pressure.repair_moves[0].move = "Tell them they must respond immediately — final notice";
  const r4 = qcComm(CommOutput.parse(pressure), { allowed_strategy_zone: "yellow", drift_status: "none" });
  check("pressure-language repair move in yellow case FAILS QC", !r4.passed);

  const unbounded = structuredClone(validComm);
  unbounded.response_interpretation_rules[1].bounded_interpretation = "they are definitely not interested";
  const r5 = qcComm(CommOutput.parse(unbounded), { allowed_strategy_zone: "green", drift_status: "none" });
  check("certainty language on non-green interpretation FAILS QC", !r5.passed);
}

// ---------- interaction_update_v1 + input builders
console.log("interaction_update_v1 + input packet builders:");
{
  check("valid packet accepted", PostInteractionUpdatePacket.safeParse({
    update_schema_version: "interaction_update_v1", what_was_sent: "date-confirm email",
    response_observed: "confirmed both dates", response_classification: "positive-confirmation",
    confidence_change: "increase", friction_signals_observed: [], drift_signals_observed: [],
    recommended_upstream_updates: [],
  }).success);
  check("wrong schema version REJECTED", !PostInteractionUpdatePacket.safeParse({
    update_schema_version: "interaction_update_v2", what_was_sent: "", response_observed: "",
    response_classification: "", confidence_change: "none", friction_signals_observed: [],
    drift_signals_observed: [], recommended_upstream_updates: [],
  }).success);
  check("bad confidence_change REJECTED", !PostInteractionUpdatePacket.safeParse({
    update_schema_version: "interaction_update_v1", what_was_sent: "", response_observed: "",
    response_classification: "", confidence_change: "way up", friction_signals_observed: [],
    drift_signals_observed: [], recommended_upstream_updates: [],
  }).success);

  const req = {
    source_profile_id: "contact-1", target_label: "Tameka Turner", full_name: "Tameka Turner",
    aliases: [], profile_urls: [], location: ["Orlando, FL"], employer: ["Rosen Centre Hotel"],
    industry: ["hospitality"], use_case: "venue negotiation", relationship_context: "active vendor",
    stakes_level: "high" as const, desired_outcome: "confirm dates and rates", channel: "email" as const,
  };
  const p1 = buildPerplexityInput(req);
  check("stage-1 input embeds confidence_rules_v1 verbatim",
    (p1.confidence_rule_set as Record<string, unknown>).version === "confidence_rules_v1" &&
    (p1.confidence_rule_set as { promotion_rules: string[] }).promotion_rules.length === 4 &&
    (p1.confidence_rule_set as { suppression_rules: string[] }).suppression_rules.length === 4 &&
    (p1.confidence_rule_set as { review_triggers: string[] }).review_triggers.length === 5);
  check("stage-1 schema_packet lists all 16 required output fields",
    (p1.schema_packet.required_output_fields as string[]).length === 16);
  const p2 = buildPersonaInput(req, validPerplexity.handoff_packet as unknown as Record<string, unknown>, {});
  check("stage-2 input carries perplexity handoff + 22 required fields",
    (p2.schema_packet.required_output_fields as string[]).length === 22);
  const p3 = buildCommInput(req, validPersona.claude_handoff_packet as unknown as Record<string, unknown>);
  check("stage-3 input carries claude handoff + 21 required fields",
    (p3.schema_packet.required_output_fields as string[]).length === 21);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
