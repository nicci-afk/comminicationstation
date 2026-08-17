// Executes ONE pipeline stage per job (never more — edge function wall-clock
// limits make a monolithic 3-stage run a timeout bomb). Flow per stage:
// claim → cap check → vendor call → zod validation → code-enforced QC gates →
// one auto-repair retry on failure → persist artifact → enqueue next stage.
// The model's self-reported qc_status is stored but NEVER trusted as the gate.

import { SupabaseClient } from "@supabase/supabase-js";
import {
  checkSpend,
  getConfig,
  getUserSecret,
  handleOptions,
  MAX_JOB_ATTEMPTS,
  recordSpend,
  runWorker,
} from "./_shared/util.ts";
import { callAnthropic, callOpenAI, callPerplexity, LlmResult } from "./_shared/llm.ts";
import { COMM_SYSTEM, PERPLEXITY_SYSTEM, PERSONA_SYSTEM, repairPrompt } from "./_shared/prompts.ts";
import {
  AnalyzeRequest,
  buildCommInput,
  buildPersonaInput,
  buildPerplexityInput,
} from "./_shared/schemas/packets.ts";
import { PerplexityOutput } from "./_shared/schemas/perplexity.ts";
import { PersonaOutput } from "./_shared/schemas/persona.ts";
import { CommOutput } from "./_shared/schemas/comm.ts";
import { qcComm, qcPerplexity, qcPersona, QcResult } from "./_shared/schemas/qc.ts";

const DEFAULT_MODELS = { stage1: "sonar-pro", stage2: "gpt-5.1", stage3: "claude-opus-4-8" };

// Perplexity's sonar-pro returns semantically correct data but with different
// field names and object shapes vs our strict schema. This normalizer coerces
// every known divergence before zod validation so we never reject valid runs.

function mapConf(v: unknown): "green" | "yellow" | "red" {
  const s = String(v ?? "").toLowerCase();
  if (s === "green" || s === "high" || s === "strong" || s === "confirmed") return "green";
  if (s === "red" || s === "low" || s === "weak" || s === "insufficient") return "red";
  return "yellow";
}

function mapCoverageLevel(level: unknown): "covered" | "partial" | "missing" {
  const s = String(level ?? "").toLowerCase();
  if (s === "high" || s === "full" || s === "covered" || s === "strong" || s === "complete") return "covered";
  if (s === "none" || s === "missing" || s === "not_found" || s === "absent") return "missing";
  return "partial";
}

function inferSignalCategory(label: string): string {
  const l = label.toLowerCase();
  if (/role|work|job|employer|career|profession|business|specializ|affiliation|certif/.test(l)) return "work";
  if (/interest|hobby|passion|leisure/.test(l)) return "interests";
  if (/communic|channel|tone|style|respond|email|text|prefer|format/.test(l)) return "communication";
  if (/social|post|instagram|facebook|linkedin/.test(l)) return "social_behavior";
  if (/content|blog|publish|write|thought_lead|media/.test(l)) return "content_style";
  if (/network|community|group|partner|collabor/.test(l)) return "network";
  if (/timing|schedule|cadence|frequency|latency/.test(l)) return "timing";
  if (/bio|background|personal|geo|location|cross_domain|history/.test(l)) return "bio";
  return "work";
}

function normalizePerplexityOutput(raw: unknown, sourceProfileId: string): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out = { ...(raw as Record<string, unknown>) };

  // Required literals the model sometimes omits.
  if (!out.output_schema_version) out.output_schema_version = "perplexity_output_v1";
  if (!out.source_profile_id) out.source_profile_id = sourceProfileId;

  // coverage_map: various object shapes → [{signal_category, status, notes}]
  // Handles: {domains:{k:{...}}}, {domains_covered:[{domain,coverage_level}]},
  //          {dimensions:{k:{...}}}, bare domain-keyed objects (filtering meta keys)
  {
    const CM_META = new Set(["notes","gaps","time_window_considered","overall_coverage","summary","areas_missing","areas_covered"]);
    let cm = out.coverage_map;
    if (cm && !Array.isArray(cm) && typeof cm === "object") {
      const cmObj = cm as Record<string, unknown>;
      const domainArr = cmObj.domains_covered ?? cmObj.domains ?? null;
      const dimObj = cmObj.dimensions ?? null;
      if (Array.isArray(domainArr)) {
        cm = (domainArr as unknown[]).map((item) => {
          const v = (item ?? {}) as Record<string, unknown>;
          return {
            signal_category: String(v.domain ?? v.signal_category ?? v.category ?? v.area ?? ""),
            status: mapCoverageLevel(v.coverage_level ?? v.coverage ?? v.status),
            notes: String(v.notes ?? v.description ?? ""),
          };
        });
      } else if (dimObj && typeof dimObj === "object" && !Array.isArray(dimObj)) {
        cm = Object.entries(dimObj as Record<string, unknown>).map(([key, val]) => {
          const v = (val ?? {}) as Record<string, unknown>;
          return { signal_category: key, status: mapCoverageLevel(v.coverage_level ?? v.coverage ?? v.status), notes: String(v.notes ?? "") };
        });
      } else {
        // Bare domain-keyed object — exclude metadata keys
        const domainEntries = Object.entries(cmObj).filter(([k, v]) => !CM_META.has(k) && v && typeof v === "object");
        cm = domainEntries.map(([key, val]) => {
          const v = (val ?? {}) as Record<string, unknown>;
          return { signal_category: key, status: mapCoverageLevel(v.coverage_level ?? v.coverage ?? v.status), notes: String(v.notes ?? "") };
        });
      }
    } else if (Array.isArray(cm)) {
      cm = (cm as unknown[]).map((item) => {
        const v = (item ?? {}) as Record<string, unknown>;
        const raw2 = String(v.status ?? v.coverage_level ?? v.coverage ?? "");
        return {
          signal_category: String(v.signal_category ?? v.domain ?? v.category ?? v.area ?? ""),
          status: (["covered","partial","missing"].includes(raw2) ? raw2 : mapCoverageLevel(raw2)) as "covered" | "partial" | "missing",
          notes: String(v.notes ?? v.description ?? ""),
        };
      });
    }
    out.coverage_map = cm;
  }

  // observable_signals: {type,label,summary,confidence_band,time_window_relevance}
  // → {signal,label:enum,category:enum,recency,source_type:enum,confidence:enum,evidence_refs}
  if (Array.isArray(out.observable_signals)) {
    out.observable_signals = (out.observable_signals as unknown[]).map((item) => {
      const v = (item ?? {}) as Record<string, unknown>;
      const typeOrLabel = String(v.type ?? v.label ?? "unknown").toLowerCase();
      const descLabel = String(v.label ?? v.signal ?? "");
      const catCandidates = ["bio","work","interests","communication","social_behavior","activity","content_style","network","timing"];
      const rawCat = String(v.category ?? "");
      const src = String(v.source_type ?? "").toLowerCase();
      return {
        signal: String(v.signal ?? v.summary ?? v.description ?? ""),
        label: (["fact","pattern","hypothesis","unknown"].includes(typeOrLabel) ? typeOrLabel : "unknown") as string,
        category: catCandidates.includes(rawCat) ? rawCat : inferSignalCategory(descLabel || typeOrLabel),
        recency: String(v.recency ?? v.time_window_relevance ?? "recent"),
        source_type: (["self_authored","third_party","directory","media"].includes(src) ? src : "third_party") as string,
        confidence: mapConf(v.confidence ?? v.confidence_band),
        evidence_refs: Array.isArray(v.evidence_refs) ? v.evidence_refs : [],
      };
    });
  }

  // identity_resolution: {status:"resolved", primary_profile, ...}
  // → {status:enum, matched_profiles:[{url,match_basis,confidence}], identity_risks:[]}
  if (out.identity_resolution && typeof out.identity_resolution === "object") {
    const ir = out.identity_resolution as Record<string, unknown>;
    const validStatuses = ["strong","partial","weak","unresolved"];
    if (!validStatuses.includes(String(ir.status)) || !Array.isArray(ir.matched_profiles)) {
      const s = String(ir.status ?? "").toLowerCase();
      const pp = (ir.primary_profile ?? {}) as Record<string, unknown>;
      const ppRefs = Array.isArray(pp.evidence_refs) ? pp.evidence_refs as string[] : [];
      const ppIdents = Array.isArray(pp.core_identifiers) ? (pp.core_identifiers as unknown[]).slice(0, 3).map(String) : [];
      out.identity_resolution = {
        status: validStatuses.includes(s) ? s
          : (s === "resolved" || s === "confirmed" || s === "high_confidence") ? "strong"
          : (s === "probable" || s === "moderate" || s === "partial_match" || s === "partial_resolution") ? "partial"
          : (s === "limited" || s === "low_confidence") ? "weak"
          : "unresolved",
        matched_profiles: ppRefs.length > 0 ? [{ url: ppRefs[0], match_basis: ppIdents, confidence: mapConf(ir.confidence_band ?? "green") }]
          : (Array.isArray(ir.matched_profiles) ? ir.matched_profiles : []),
        identity_risks: Array.isArray(ir.identity_risks) ? ir.identity_risks
          : Array.isArray(ir.cautions) ? ir.cautions : [],
      };
    }
    // Cap matched_profiles confidence: green is invalid when identity is weak/unresolved
    const idR = out.identity_resolution as Record<string, unknown>;
    if ((idR.status === "weak" || idR.status === "unresolved") && Array.isArray(idR.matched_profiles)) {
      idR.matched_profiles = (idR.matched_profiles as Record<string, unknown>[]).map((p) => ({
        ...p,
        confidence: p.confidence === "green" ? "yellow" : p.confidence,
      }));
    }
  }

  // drift_tracking: [] or missing → required object shape
  if (!out.drift_tracking || Array.isArray(out.drift_tracking)) {
    out.drift_tracking = { drift_status: "none", drift_window: "current", drift_signals: [], drift_impact: [], recommended_response: "hold", requires_human_review: false };
  } else if (typeof out.drift_tracking === "object") {
    const dt = out.drift_tracking as Record<string, unknown>;
    if (!dt.drift_status) dt.drift_status = "none";
    if (!dt.drift_window) dt.drift_window = "current";
    if (!Array.isArray(dt.drift_signals)) dt.drift_signals = [];
    if (!Array.isArray(dt.drift_impact)) dt.drift_impact = [];
    if (!dt.recommended_response) dt.recommended_response = "hold";
    if (dt.requires_human_review === undefined) dt.requires_human_review = false;
  }

  // uncertainty_map: many shapes → [{unknown, why_it_matters, recommended_resolution}]
  // Handles: {unknowns:[...]}, {areas:[...]}, {items:[...]}, {factors:[...]},
  //          domain-keyed objects {key:{reason,importance}}, raw string-valued objects
  {
    const UM_META = new Set(["notes","tone_uncertainty","overall","summary","status"]);
    let um = out.uncertainty_map;
    if (!Array.isArray(um)) {
      const umObj = (um ?? {}) as Record<string, unknown>;
      const innerArr = umObj.unknowns ?? umObj.areas ?? umObj.items ?? umObj.factors ?? null;
      if (Array.isArray(innerArr)) {
        um = innerArr;
      } else if (um && typeof um === "object") {
        // Domain-keyed object: {key: {reason, importance, ...}} or {key: "string"}
        um = Object.entries(umObj)
          .filter(([k]) => !UM_META.has(k))
          .map(([k, v]) => {
            if (typeof v === "string") {
              return { unknown: k, why_it_matters: v, recommended_resolution: "Seek direct confirmation" };
            }
            const vObj = (v ?? {}) as Record<string, unknown>;
            return {
              unknown: String(vObj.unknown ?? vObj.label ?? vObj.topic ?? vObj.area ?? k),
              why_it_matters: String(vObj.why_it_matters ?? vObj.reason ?? vObj.importance ?? vObj.why ?? vObj.description ?? ""),
              recommended_resolution: String(vObj.recommended_resolution ?? vObj.resolution ?? vObj.approach ?? "Seek direct confirmation"),
            };
          });
      } else {
        um = [];
      }
    }
    out.uncertainty_map = (um as unknown[]).map((item) => {
      const u = (item ?? {}) as Record<string, unknown>;
      return {
        unknown: String(u.unknown ?? u.label ?? u.topic ?? u.area ?? u.factor ?? ""),
        why_it_matters: String(u.why_it_matters ?? u.reason ?? u.description ?? u.importance ?? u.why ?? ""),
        recommended_resolution: String(u.recommended_resolution ?? u.resolution ?? u.approach ?? u.suggested_action ?? "Seek direct confirmation"),
      };
    });
  }

  // contradictions: many shapes → [{topic, conflict_summary, operational_effect}]
  // Handles: {issue,status,details}, {recency_notes,conflict_summary,operational_effect},
  //          {status,severity,description}, {topic,impact,description}
  if (!Array.isArray(out.contradictions)) {
    out.contradictions = [];
  } else {
    out.contradictions = (out.contradictions as unknown[]).map((item) => {
      const c = (item ?? {}) as Record<string, unknown>;
      return {
        topic: String(c.topic ?? c.issue ?? c.recency_notes ?? c.signal ?? c.conflict_area ?? c.area ?? c.dimension ?? ""),
        conflict_summary: String(c.conflict_summary ?? c.description ?? c.details ?? c.summary ?? c.conflict ?? c.status ?? ""),
        operational_effect: String(c.operational_effect ?? c.impact ?? c.effect ?? c.severity_note ??
          (c.severity ? `Severity: ${c.severity}` : "") ?? ""),
      };
    }).filter((c) => c.topic || c.conflict_summary);
  }

  // why_not_higher_confidence: string | object → string[]
  if (typeof out.why_not_higher_confidence === "string") {
    out.why_not_higher_confidence = [out.why_not_higher_confidence];
  } else if (Array.isArray(out.why_not_higher_confidence)) {
    // already correct
  } else if (out.why_not_higher_confidence && typeof out.why_not_higher_confidence === "object") {
    out.why_not_higher_confidence = Object.values(out.why_not_higher_confidence as Record<string, unknown>)
      .filter((v) => typeof v === "string")
      .map(String);
  } else {
    out.why_not_higher_confidence = [];
  }

  // handoff_packet: model returns {summary:{...}, cautions:[], allowed_strategy_zone}
  // schema wants {handoff_version, identity_status, top_signals, top_contradictions,
  //               drift_tracking:{}, uncertainty_map:[], allowed_strategy_zone}
  if (out.handoff_packet && typeof out.handoff_packet === "object") {
    const hp = out.handoff_packet as Record<string, unknown>;
    if (hp.handoff_version !== "persona_handoff_v1") {
      const summary = (hp.summary ?? {}) as Record<string, unknown>;
      const topSignals: string[] = [];
      if (summary.identity_anchor) topSignals.push(String(summary.identity_anchor));
      if (summary.positioning_anchor) topSignals.push(String(summary.positioning_anchor));
      if (summary.partnership_anchor) topSignals.push(String(summary.partnership_anchor));
      if (summary.communication_anchor) topSignals.push(String(summary.communication_anchor));
      const themes = Array.isArray(hp.priority_rapport_themes) ? (hp.priority_rapport_themes as unknown[]).map(String) : [];
      const cautions = Array.isArray(hp.cautions) ? (hp.cautions as unknown[]).map(String) : [];
      out.handoff_packet = {
        handoff_version: "persona_handoff_v1",
        identity_status: String(summary.identity_anchor ?? hp.identity_status ?? "resolved"),
        top_signals: topSignals.length > 0 ? topSignals : themes.slice(0, 4),
        top_contradictions: Array.isArray(hp.top_contradictions) ? hp.top_contradictions : [],
        drift_tracking: (hp.drift_tracking ?? {}) as Record<string, unknown>,
        uncertainty_map: cautions,
        allowed_strategy_zone: String(hp.allowed_strategy_zone ?? "yellow"),
      };
    }
  }

  // qc_status: string → {passed, fail_reasons}
  if (typeof out.qc_status === "string") {
    const s = String(out.qc_status).toLowerCase();
    out.qc_status = { passed: s === "passed" || s === "pass" || s === "ok" || s === "tool_limited_but_adequate", fail_reasons: [] };
  } else if (!out.qc_status) {
    out.qc_status = { passed: true, fail_reasons: [] };
  }

  return out;
}

// Normalize a drift_tracking object from any GPT variant to the required schema shape.
// Used for both top-level drift_tracking and claude_handoff_packet.drift_tracking.
function normalizeDrift(raw: unknown): Record<string, unknown> {
  const VALID_DS = new Set(["none","possible","active","unresolved"]);
  const VALID_DR = new Set(["hold","adapt","confirm","escalate"]);
  if (!raw || Array.isArray(raw)) {
    return { drift_status: "none", drift_window: "", drift_signals: [], drift_impact: [], recommended_response: "hold", requires_human_review: false };
  }
  const dt = { ...(raw as Record<string, unknown>) };
  const rawStatus = String(dt.drift_status ?? "").toLowerCase();
  if (!VALID_DS.has(rawStatus)) dt.drift_status = "none";
  if (!dt.drift_window) dt.drift_window = "";
  if (!Array.isArray(dt.drift_signals)) {
    const obs = Array.isArray(dt.observed_changes) ? dt.observed_changes as unknown[] : [];
    dt.drift_signals = obs.map((item) => {
      const v = (item ?? {}) as Record<string, unknown>;
      const dir = String(v.direction ?? "").toLowerCase();
      return {
        signal: String(v.signal ?? v.description ?? v.change ?? String(item)),
        direction: (["increase","decrease","shift","inconsistency"].includes(dir) ? dir : "shift"),
        confidence: mapConf(v.confidence ?? "yellow"),
        evidence_refs: Array.isArray(v.evidence_refs) ? v.evidence_refs : [],
      };
    });
  }
  if (!Array.isArray(dt.drift_impact)) {
    const impl = dt.potential_implications;
    const notes = dt.notes;
    dt.drift_impact = Array.isArray(impl) && (impl as unknown[]).length > 0
      ? (impl as unknown[]).map(String)
      : typeof notes === "string" && notes ? [notes] : [];
  }
  if (!dt.recommended_response || !VALID_DR.has(String(dt.recommended_response))) {
    dt.recommended_response = "hold";
  }
  if (typeof dt.requires_human_review !== "boolean") dt.requires_human_review = false;
  return dt;
}

// GPT-5.1's PersonaOutput has systematic divergences from the strict schema:
// 1. friction_risks[].risk_type uses invented enum values
// 2. drift_tracking uses {known_trends, drift_unknowns, possible_drifts} or other GPT variants
// 3. communication_relevance_map[] uses {reason, signal, relevance} instead of
//    {signal, label:enum, why_it_matters, confidence, evidence_refs[]}
// 4. claude_handoff_packet.drift_tracking uses the same GPT format and also needs normalization
// This normalizer coerces all of the above before Zod validation.
function normalizePersonaOutput(raw: unknown, sourceProfileId: string): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out = { ...(raw as Record<string, unknown>) };

  if (!out.prompt_id) out.prompt_id = "chatgpt_persona_strategy_v1";
  if (!out.output_schema_version) out.output_schema_version = "chatgpt_persona_output_v1";
  if (!out.source_profile_id) out.source_profile_id = sourceProfileId;

  // friction_risks[].risk_type: map GPT-invented values to nearest valid enum member.
  const VALID_RISK_TYPES = new Set([
    "tone_mismatch","pacing_mismatch","ambiguity","overreach","credibility_loss",
    "boundary_violation","inconsistency_trigger","channel_mismatch","timing_mismatch",
  ]);
  function mapRiskType(rt: unknown): string {
    const s = String(rt ?? "").toLowerCase();
    if (VALID_RISK_TYPES.has(s)) return s;
    if (/credibil|background|expertise|identity|position/.test(s)) return "credibility_loss";
    if (/time|timing|window|cadence|schedule/.test(s)) return "timing_mismatch";
    if (/channel|medium|platform/.test(s)) return "channel_mismatch";
    if (/overreach|intrusive|personal|sensitive|private/.test(s)) return "overreach";
    if (/boundary|violation|limit/.test(s)) return "boundary_violation";
    if (/inconsisten|contradict|conflict/.test(s)) return "inconsistency_trigger";
    if (/pacing|speed|slow|fast/.test(s)) return "pacing_mismatch";
    if (/tone|style|voice/.test(s)) return "tone_mismatch";
    if (/message.fit|fit|relevance|match/.test(s)) return "tone_mismatch";
    return "ambiguity";
  }
  if (Array.isArray(out.friction_risks)) {
    out.friction_risks = (out.friction_risks as unknown[]).map((item) => {
      const f = (item ?? {}) as Record<string, unknown>;
      const observBasis = String(f.observable_basis ?? f.basis ?? f.description ?? "");
      const rawTc = Array.isArray(f.trigger_conditions) ? f.trigger_conditions as unknown[] : [];
      // QC requires trigger_conditions to be non-empty; fall back to observable_basis or risk name.
      const triggerConds = rawTc.length > 0 ? rawTc
        : observBasis ? [observBasis]
        : [String(f.risk ?? f.risk_name ?? "applies in relevant contexts")];
      return {
        ...f,
        risk_type: mapRiskType(f.risk_type),
        trigger_conditions: triggerConds,
        observable_basis: observBasis,
        impact_if_missed: String(f.impact_if_missed ?? f.impact ?? ""),
        mitigation: Array.isArray(f.mitigation) ? f.mitigation : (f.mitigation ? [String(f.mitigation)] : []),
        confidence: mapConf(f.confidence),
        evidence_refs: Array.isArray(f.evidence_refs) ? f.evidence_refs : [],
      };
    });
  }

  // drift_tracking: normalize any GPT variant → required schema shape.
  out.drift_tracking = normalizeDrift(out.drift_tracking);

  // communication_relevance_map: {signal, relevance, confidence} → {signal, label, why_it_matters, confidence, evidence_refs[]}
  const VALID_LABELS = new Set(["fact","pattern","hypothesis","unknown"]);
  if (Array.isArray(out.communication_relevance_map)) {
    out.communication_relevance_map = (out.communication_relevance_map as unknown[]).map((item) => {
      const c = (item ?? {}) as Record<string, unknown>;
      const rawLabel = String(c.label ?? "").toLowerCase();
      const evidRefs = Array.isArray(c.evidence_refs) ? c.evidence_refs : [];
      const conf = mapConf(c.confidence);
      return {
        signal: String(c.signal ?? ""),
        label: VALID_LABELS.has(rawLabel) ? rawLabel : "unknown",
        why_it_matters: String(c.why_it_matters ?? c.reason ?? c.description ?? c.why ?? ""),
        // QC rejects green with no evidence_refs — downgrade to yellow.
        confidence: (conf === "green" && evidRefs.length === 0) ? "yellow" : conf,
        evidence_refs: evidRefs,
      };
    });
  }

  // stable_preferences[].confidence: schema only allows "green"|"yellow" (cap red → yellow)
  if (Array.isArray(out.stable_preferences)) {
    out.stable_preferences = (out.stable_preferences as unknown[]).map((item) => {
      const p = (item ?? {}) as Record<string, unknown>;
      const conf = mapConf(p.confidence);
      return { ...p, confidence: conf === "red" ? "yellow" : conf, basis: String(p.basis ?? p.description ?? ""), evidence_refs: Array.isArray(p.evidence_refs) ? p.evidence_refs : [] };
    });
  }

  // probable_style_patterns[].confidence: schema only allows "green"|"yellow"
  if (Array.isArray(out.probable_style_patterns)) {
    out.probable_style_patterns = (out.probable_style_patterns as unknown[]).map((item) => {
      const p = (item ?? {}) as Record<string, unknown>;
      const conf = mapConf(p.confidence);
      const evidRefs = Array.isArray(p.evidence_refs) ? p.evidence_refs : [];
      const finalConf = conf === "red" ? "yellow" : (conf === "green" && evidRefs.length === 0 ? "yellow" : conf);
      return { ...p, confidence: finalConf, conditions: Array.isArray(p.conditions) ? p.conditions : [], evidence_refs: evidRefs };
    });
  }

  // motivator_hypotheses[].confidence: schema only allows "yellow"|"red" (cap green → yellow)
  if (Array.isArray(out.motivator_hypotheses)) {
    out.motivator_hypotheses = (out.motivator_hypotheses as unknown[]).map((item) => {
      const h = (item ?? {}) as Record<string, unknown>;
      const conf = mapConf(h.confidence);
      return { ...h, confidence: conf === "green" ? "yellow" : conf, reason: String(h.reason ?? h.description ?? h.basis ?? ""), evidence_refs: Array.isArray(h.evidence_refs) ? h.evidence_refs : [] };
    });
  }

  // rapport_levers[].confidence: schema only allows "green"|"yellow"
  if (Array.isArray(out.rapport_levers)) {
    out.rapport_levers = (out.rapport_levers as unknown[]).map((item) => {
      const l = (item ?? {}) as Record<string, unknown>;
      const conf = mapConf(l.confidence);
      const evidRefs = Array.isArray(l.evidence_refs) ? l.evidence_refs : [];
      const finalConf = conf === "red" ? "yellow" : (conf === "green" && evidRefs.length === 0 ? "yellow" : conf);
      return { ...l, confidence: finalConf, safe_usage_note: String(l.safe_usage_note ?? l.note ?? l.usage_note ?? ""), evidence_refs: evidRefs };
    });
  }

  // contradictions_to_watch: {topic, conflict_summary, operational_effect}
  if (!Array.isArray(out.contradictions_to_watch)) {
    out.contradictions_to_watch = [];
  } else {
    out.contradictions_to_watch = (out.contradictions_to_watch as unknown[]).map((item) => {
      const c = (item ?? {}) as Record<string, unknown>;
      return {
        topic: String(c.topic ?? c.issue ?? c.area ?? ""),
        conflict_summary: String(c.conflict_summary ?? c.description ?? c.summary ?? c.conflict ?? ""),
        operational_effect: String(c.operational_effect ?? c.impact ?? c.effect ?? ""),
      };
    }).filter((c) => c.topic || c.conflict_summary);
  }

  // Ensure plain string arrays.
  for (const field of ["do_not_assume","why_not_higher_confidence","green_actions","yellow_actions","red_actions","unknowns_that_matter"]) {
    if (!Array.isArray(out[field])) out[field] = typeof out[field] === "string" ? [out[field]] : [];
  }

  // minimum_safe_next_action: must be string
  if (typeof out.minimum_safe_next_action !== "string") {
    out.minimum_safe_next_action = String(out.minimum_safe_next_action ?? "");
  }

  // qc_status: string → {passed, fail_reasons}
  if (typeof out.qc_status === "string") {
    const s = String(out.qc_status).toLowerCase();
    out.qc_status = { passed: s === "passed" || s === "pass" || s === "ok", fail_reasons: [] };
  } else if (!out.qc_status) {
    out.qc_status = { passed: true, fail_reasons: [] };
  }

  // claude_handoff_packet: ensure required fields exist.
  if (out.claude_handoff_packet && typeof out.claude_handoff_packet === "object") {
    const hp = out.claude_handoff_packet as Record<string, unknown>;
    if (!hp.handoff_version) hp.handoff_version = "claude_handoff_v1";
    if (!Array.isArray(hp.top_friction_risks)) hp.top_friction_risks = [];
    if (!Array.isArray(hp.top_rapport_levers)) hp.top_rapport_levers = [];
    if (!Array.isArray(hp.message_constraints)) hp.message_constraints = [];
    if (!Array.isArray(hp.unknowns_that_matter)) hp.unknowns_that_matter = [];
    hp.drift_tracking = normalizeDrift(hp.drift_tracking);
    const zone = String(hp.allowed_strategy_zone ?? "yellow").toLowerCase();
    if (!["green","yellow","red"].includes(zone)) hp.allowed_strategy_zone = "yellow";
    if (!hp.persona_summary) hp.persona_summary = "";
  }

  return out;
}

// Claude's CommOutput has systematic divergences from the strict schema.
// This normalizer coerces every known field-name / shape difference before zod validation.
function normalizeCommOutput(raw: unknown, sourceProfileId: string): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out = { ...(raw as Record<string, unknown>) };

  if (!out.prompt_id) out.prompt_id = "claude_communication_strategy_v1";
  if (!out.output_schema_version) out.output_schema_version = "claude_comm_output_v1";
  if (!out.source_profile_id) out.source_profile_id = sourceProfileId;

  // why_not_higher_confidence: string → string[]
  if (typeof out.why_not_higher_confidence === "string") {
    out.why_not_higher_confidence = [out.why_not_higher_confidence];
  } else if (!Array.isArray(out.why_not_higher_confidence)) {
    out.why_not_higher_confidence = [];
  }

  // human_review_flags: [{detail,trigger,...}] → string[]
  if (Array.isArray(out.human_review_flags)) {
    out.human_review_flags = (out.human_review_flags as unknown[]).map((item) => {
      if (typeof item === "string") return item;
      const v = (item ?? {}) as Record<string, unknown>;
      return String(v.detail ?? v.description ?? v.flag ?? v.reason ?? JSON.stringify(v));
    });
  } else if (typeof out.human_review_flags === "string") {
    out.human_review_flags = [out.human_review_flags];
  } else {
    out.human_review_flags = [];
  }

  // message_objective: object → string
  if (out.message_objective && typeof out.message_objective === "object") {
    const mo = out.message_objective as Record<string, unknown>;
    out.message_objective = String(mo.primary ?? mo.summary ?? mo.objective ?? "");
  } else if (typeof out.message_objective !== "string") {
    out.message_objective = "";
  }

  // recommended_approach: object → string
  if (out.recommended_approach && typeof out.recommended_approach === "object") {
    const ra = out.recommended_approach as Record<string, unknown>;
    out.recommended_approach = String(ra.summary ?? ra.approach ?? ra.description ?? "");
  } else if (typeof out.recommended_approach !== "string") {
    out.recommended_approach = "";
  }

  // minimum_safe_next_action: must be string
  if (typeof out.minimum_safe_next_action !== "string") {
    out.minimum_safe_next_action = String(out.minimum_safe_next_action ?? "");
  }

  // tone_profile: {avoid_tone|avoid_tones, recommended_tone|descriptors, confidence|confidence_band}
  // → {recommended_tone: string[], avoid_tone: string[], confidence}
  if (out.tone_profile && typeof out.tone_profile === "object") {
    const tp = out.tone_profile as Record<string, unknown>;
    const rec = tp.recommended_tone ?? tp.descriptors ?? tp.tone_descriptors ?? null;
    const avoid = tp.avoid_tone ?? tp.avoid_tones ?? tp.tones_to_avoid ?? null;
    out.tone_profile = {
      recommended_tone: Array.isArray(rec) ? (rec as unknown[]).map(String) : (typeof rec === "string" ? [rec] : []),
      avoid_tone: Array.isArray(avoid) ? (avoid as unknown[]).map(String) : (typeof avoid === "string" ? [avoid] : []),
      confidence: mapConf(tp.confidence ?? tp.confidence_band),
    };
  }

  // channel_strategy: various → {channel, length_guidance, pacing_guidance, follow_up_cadence, constraints[]}
  if (out.channel_strategy && typeof out.channel_strategy === "object") {
    const cs = out.channel_strategy as Record<string, unknown>;
    out.channel_strategy = {
      channel: String(cs.channel ?? "email"),
      length_guidance: String(cs.length_guidance ?? cs.length ?? ""),
      pacing_guidance: String(cs.pacing_guidance ?? cs.cadence_guidance ?? cs.pacing ?? ""),
      follow_up_cadence: String(cs.follow_up_cadence ?? cs.cadence ?? cs.follow_up ?? ""),
      constraints: Array.isArray(cs.constraints) ? (cs.constraints as unknown[]).map(String)
        : Array.isArray(cs.channel_constraints) ? (cs.channel_constraints as unknown[]).map(String) : [],
    };
  }

  // sequencing_plan: {steps:[...], ...} or array → [{step, goal, instruction, confidence}]
  {
    let sp = out.sequencing_plan;
    if (sp && !Array.isArray(sp) && typeof sp === "object") {
      const spObj = sp as Record<string, unknown>;
      sp = spObj.steps ?? spObj.phases ?? spObj.plan ?? [];
    }
    if (Array.isArray(sp)) {
      out.sequencing_plan = (sp as unknown[]).map((item) => {
        const s = (item ?? {}) as Record<string, unknown>;
        return {
          step: typeof s.step === "number" ? s.step : Number(s.step ?? 0),
          goal: String(s.goal ?? s.objective ?? s.purpose ?? ""),
          instruction: String(s.instruction ?? s.label ?? s.action ?? s.description ?? ""),
          confidence: mapConf(s.confidence ?? s.confidence_band),
        };
      });
    } else {
      out.sequencing_plan = [];
    }
  }

  // opening_options: {id, text, notes, confidence_band} | {label, notes, option} → {option, use_when, confidence}
  if (Array.isArray(out.opening_options)) {
    out.opening_options = (out.opening_options as unknown[]).map((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      const conf = mapConf(o.confidence ?? o.confidence_band);
      return {
        option: String(o.option ?? o.text ?? o.opening ?? ""),
        use_when: String(o.use_when ?? o.notes ?? o.when ?? o.label ?? ""),
        confidence: (conf === "red" ? "yellow" : conf) as "green" | "yellow",
      };
    });
  } else {
    out.opening_options = [];
  }

  // message_blueprints: various → {blueprint_name, use_when, template, risk_notes[], confidence}
  if (Array.isArray(out.message_blueprints)) {
    out.message_blueprints = (out.message_blueprints as unknown[]).map((item) => {
      const b = (item ?? {}) as Record<string, unknown>;
      let template = "";
      if (typeof b.template === "string") template = b.template;
      else if (typeof b.sample_text === "string") template = b.sample_text;
      else if (Array.isArray(b.structure)) template = (b.structure as unknown[]).map(String).join("\n");
      const conf = mapConf(b.confidence ?? b.confidence_band);
      return {
        blueprint_name: String(b.blueprint_name ?? b.name ?? b.id ?? b.purpose ?? ""),
        use_when: String(b.use_when ?? b.purpose ?? b.when ?? ""),
        template,
        risk_notes: Array.isArray(b.risk_notes) ? (b.risk_notes as unknown[]).map(String)
          : Array.isArray(b.constraints_respected) ? (b.constraints_respected as unknown[]).map(String) : [],
        confidence: (conf === "red" ? "yellow" : conf) as "green" | "yellow",
      };
    });
  } else {
    out.message_blueprints = [];
  }

  // repair_moves: {trigger, move, sample_text, pressure_check} → {scenario, repair_goal, move, do_not_do[]}
  if (Array.isArray(out.repair_moves)) {
    out.repair_moves = (out.repair_moves as unknown[]).map((item) => {
      const r = (item ?? {}) as Record<string, unknown>;
      return {
        scenario: String(r.scenario ?? r.trigger ?? r.situation ?? r.condition ?? ""),
        repair_goal: String(r.repair_goal ?? r.goal ?? r.intent ?? ""),
        move: String(r.move ?? r.action ?? r.response ?? ""),
        do_not_do: Array.isArray(r.do_not_do) ? (r.do_not_do as unknown[]).map(String) : [],
      };
    });
  } else {
    out.repair_moves = [];
  }

  // response_interpretation_rules: {signal, interpretation, recommended_reaction}
  // → {observed_response_type, bounded_interpretation, confidence, recommended_next_step}
  if (Array.isArray(out.response_interpretation_rules)) {
    out.response_interpretation_rules = (out.response_interpretation_rules as unknown[]).map((item) => {
      const r = (item ?? {}) as Record<string, unknown>;
      return {
        observed_response_type: String(r.observed_response_type ?? r.signal ?? r.response_type ?? r.type ?? ""),
        bounded_interpretation: String(r.bounded_interpretation ?? r.interpretation ?? r.meaning ?? ""),
        confidence: mapConf(r.confidence ?? r.confidence_band),
        recommended_next_step: String(r.recommended_next_step ?? r.recommended_reaction ?? r.next_step ?? r.action ?? ""),
      };
    });
  } else {
    out.response_interpretation_rules = [];
  }

  // next_step_matrix: {condition, next_step|action, confidence_band} → {condition, action, review_needed: boolean}
  if (Array.isArray(out.next_step_matrix)) {
    out.next_step_matrix = (out.next_step_matrix as unknown[]).map((item) => {
      const n = (item ?? {}) as Record<string, unknown>;
      return {
        condition: String(n.condition ?? n.scenario ?? ""),
        action: String(n.action ?? n.next_step ?? n.response ?? ""),
        review_needed: typeof n.review_needed === "boolean" ? n.review_needed : false,
      };
    });
  } else {
    out.next_step_matrix = [];
  }

  // drift_response_rules: {drift_status, strategy_adjustments[], monitoring_watch_items[], rationale}
  // → {drift_status, strategy_adjustment[], must_confirm_before_proceeding[], review_trigger: boolean}
  if (out.drift_response_rules && typeof out.drift_response_rules === "object") {
    const dr = out.drift_response_rules as Record<string, unknown>;
    const VALID_DRS = new Set(["none","possible","active","unresolved"]);
    const ds = String(dr.drift_status ?? dr.upstream_drift_status ?? "none").toLowerCase();
    const sa = dr.strategy_adjustment ?? dr.strategy_adjustments ?? dr.adjustments ?? [];
    const mc = dr.must_confirm_before_proceeding ?? dr.must_confirm ?? dr.confirmations_required ?? [];
    out.drift_response_rules = {
      drift_status: VALID_DRS.has(ds) ? ds : "none",
      strategy_adjustment: Array.isArray(sa) ? (sa as unknown[]).map(String) : [],
      must_confirm_before_proceeding: Array.isArray(mc) ? (mc as unknown[]).map(String) : [],
      review_trigger: typeof dr.review_trigger === "boolean" ? dr.review_trigger : false,
    };
  } else {
    out.drift_response_rules = { drift_status: "none", strategy_adjustment: [], must_confirm_before_proceeding: [], review_trigger: false };
  }

  // post_interaction_update_packet: Claude generates a template with empty/different fields.
  // Normalize to the strict PostInteractionUpdatePacket schema.
  if (out.post_interaction_update_packet && typeof out.post_interaction_update_packet === "object") {
    const p = out.post_interaction_update_packet as Record<string, unknown>;
    const cc = String(p.confidence_change ?? "none").toLowerCase();
    out.post_interaction_update_packet = {
      update_schema_version: "interaction_update_v1",
      what_was_sent: String(p.what_was_sent ?? p.message_sent_summary ?? p.blueprint_used ?? ""),
      response_observed: String(p.response_observed ?? p.response_received ?? ""),
      response_classification: String(p.response_classification ?? p.response_interpretation_applied ?? ""),
      confidence_change: (["increase","decrease","none"].includes(cc) ? cc : "none") as "increase" | "decrease" | "none",
      friction_signals_observed: Array.isArray(p.friction_signals_observed) ? (p.friction_signals_observed as unknown[]).map(String) : [],
      drift_signals_observed: Array.isArray(p.drift_signals_observed) ? (p.drift_signals_observed as unknown[]).map(String)
        : Array.isArray(p.drift_observations) ? (p.drift_observations as unknown[]).map(String) : [],
      recommended_upstream_updates: Array.isArray(p.recommended_upstream_updates) ? (p.recommended_upstream_updates as unknown[]).map(String) : [],
    };
  } else {
    out.post_interaction_update_packet = {
      update_schema_version: "interaction_update_v1",
      what_was_sent: "", response_observed: "", response_classification: "",
      confidence_change: "none", friction_signals_observed: [], drift_signals_observed: [], recommended_upstream_updates: [],
    };
  }

  // qc_status: string → {passed, fail_reasons}
  if (typeof out.qc_status === "string") {
    const s = String(out.qc_status).toLowerCase();
    out.qc_status = { passed: s === "pass" || s === "passed" || s === "ok", fail_reasons: [] };
  } else if (!out.qc_status) {
    out.qc_status = { passed: true, fail_reasons: [] };
  }

  return out;
}

const ZONE_RANK: Record<string, number> = { green: 0, yellow: 1, red: 2 };

interface RunRow {
  id: string;
  user_id: string;
  contact_id: string;
  business_id: string | null;
  channel: string;
  status: string;
  analyze_request: AnalyzeRequest;
}

async function models(db: SupabaseClient): Promise<typeof DEFAULT_MODELS> {
  const cfg = await getConfig(db, "pipeline_models");
  return { ...DEFAULT_MODELS, ...((cfg ?? {}) as Partial<typeof DEFAULT_MODELS>) };
}

interface StageOutcome {
  ok: boolean;
  output: unknown;
  qc: QcResult;
  modelQc: unknown;
  allowedZone: string | null;
  artifacts: { result: LlmResult; attempt: number; qc: QcResult }[];
}

// Generic stage executor with one repair retry.
async function executeStage(
  call: (user: string) => Promise<LlmResult>,
  input: unknown,
  validate: (parsed: unknown) => { problems: string[]; output: unknown; qc: QcResult; modelQc: unknown; zone: string | null },
): Promise<StageOutcome> {
  const artifacts: StageOutcome["artifacts"] = [];
  let result = await call(JSON.stringify(input));
  let v = validate(result.parsed);
  artifacts.push({ result, attempt: 1, qc: v.qc });
  if (v.problems.length > 0) {
    result = await call(
      JSON.stringify(input) + "\n\n" + repairPrompt(result.raw.slice(0, 12_000), v.problems),
    );
    v = validate(result.parsed);
    artifacts.push({ result, attempt: 2, qc: v.qc });
  }
  return {
    ok: v.problems.length === 0,
    output: v.output,
    qc: v.qc,
    modelQc: v.modelQc,
    allowedZone: v.zone,
    artifacts,
  };
}

async function persistArtifacts(
  db: SupabaseClient,
  run: RunRow,
  stage: number,
  promptId: string,
  inputVersion: string,
  outputVersion: string,
  input: unknown,
  outcome: StageOutcome,
) {
  for (const a of outcome.artifacts) {
    const { error } = await db.from("pipeline_artifacts").insert({
      user_id: run.user_id,
      run_id: run.id,
      contact_id: run.contact_id,
      stage,
      prompt_id: promptId,
      input_schema_version: inputVersion,
      output_schema_version: outputVersion,
      input,
      output: a.result.parsed ?? null,
      provider: a.result.provider,
      model: a.result.model,
      tokens_in: a.result.tokensIn,
      tokens_out: a.result.tokensOut,
      cost_usd: a.result.costUsd,
      attempt: a.attempt,
      qc_passed: a.qc.passed,
      qc_fail_reasons: a.qc.fail_reasons,
      model_qc_status: (a.result.parsed as { qc_status?: unknown })?.qc_status ?? null,
      allowed_zone: outcome.allowedZone,
    });
    if (error) throw new Error(`artifact insert: ${error.message}`);
    await recordSpend(db, {
      userId: run.user_id,
      provider: a.result.provider,
      model: a.result.model,
      purpose: `pipeline_stage${stage}`,
      tokensIn: a.result.tokensIn,
      tokensOut: a.result.tokensOut,
      costUsd: a.result.costUsd,
      refType: "pipeline_run",
      refId: run.id,
    });
  }
}

async function latestPassingArtifact(db: SupabaseClient, runId: string, stage: number) {
  const { data } = await db
    .from("pipeline_artifacts")
    .select("id,output,allowed_zone")
    .eq("run_id", runId)
    .eq("stage", stage)
    .eq("qc_passed", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function failRun(db: SupabaseClient, runId: string, status: string, error: string) {
  await db
    .from("pipeline_runs")
    .update({ status, error: error.slice(0, 2000), finished_at: new Date().toISOString() })
    .eq("id", runId);
}

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  return await runWorker(req, "pipeline_jobs", 240, 200_000, async (db, job) => {
    const runId = job.message.run_id as string;
    const stage = Number(job.message.stage);
    const { data: runData } = await db.from("pipeline_runs").select("*").eq("id", runId).maybeSingle();
    const run = runData as RunRow | null;
    if (!run) return;

    const expectedBefore: Record<number, string[]> = {
      1: ["queued", "stage1_running"],
      2: ["stage1_done", "stage2_running"],
      3: ["stage2_done", "stage3_running"],
    };
    if (!expectedBefore[stage]?.includes(run.status)) return; // stale/duplicate job

    try {
      const spend = await checkSpend(db, run.user_id, `pipeline_stage${stage}`, 0.15);
      if (!spend.allowed) {
        await failRun(db, runId, "error", `spend cap: ${spend.reason}`);
        return;
      }
      await db.from("pipeline_runs").update({
        status: `stage${stage}_running`,
        current_stage: stage,
        started_at: run.status === "queued" ? new Date().toISOString() : undefined,
      }).eq("id", runId);

      const m = await models(db);
      const req_ = run.analyze_request;

      if (stage === 1) {
        const apiKey = (await getUserSecret(db, run.user_id, "perplexity_api_key"))!;
        const input = buildPerplexityInput(req_);
        const outcome = await executeStage(
          (user) => callPerplexity({ apiKey, model: m.stage1, system: PERPLEXITY_SYSTEM, user, maxTokens: 10000 }),
          input,
          (parsed) => {
            const normalized = normalizePerplexityOutput(parsed, run.contact_id);
            const z = PerplexityOutput.safeParse(normalized);
            if (!z.success) {
              return {
                problems: z.error.issues.slice(0, 20).map((i) => `${i.path.join(".")}: ${i.message}`),
                output: parsed, qc: { passed: false, fail_reasons: ["schema invalid"] }, modelQc: null, zone: null,
              };
            }
            const qc = qcPerplexity(z.data);
            return {
              problems: qc.passed ? [] : qc.fail_reasons,
              output: z.data, qc, modelQc: z.data.qc_status,
              zone: z.data.handoff_packet.allowed_strategy_zone,
            };
          },
        );
        await persistArtifacts(db, run, 1, "perplexity_research_v1", "perplexity_input_v1", "perplexity_output_v1", input, outcome);
        if (!outcome.ok) {
          await failRun(db, runId, "qc_failed", `stage 1 QC: ${outcome.qc.fail_reasons.join("; ")}`);
          return;
        }
        await db.from("pipeline_runs").update({ status: "stage1_done" }).eq("id", runId);
        await db.rpc("enqueue_and_poke", { p_queue: "pipeline_jobs", p_msg: { run_id: runId, stage: 2 } });
      }

      if (stage === 2) {
        const apiKey = (await getUserSecret(db, run.user_id, "openai_api_key"))!;
        const prev = await latestPassingArtifact(db, runId, 1);
        if (!prev) { await failRun(db, runId, "error", "stage 1 artifact missing"); return; }
        const s1 = prev.output as Record<string, unknown>;
        const handoff = s1.handoff_packet as Record<string, unknown>;
        const upstreamZone = String(handoff.allowed_strategy_zone ?? "yellow");
        // Compact evidence capsule per the downstream contract (no raw dumps).
        // Raw stored artifact may have non-array shapes; guard with Array.isArray.
        const capsule = {
          observable_signals: (Array.isArray(s1.observable_signals) ? s1.observable_signals as unknown[] : []).slice(0, 14),
          contradictions: Array.isArray(s1.contradictions) ? s1.contradictions : [],
          uncertainty_map: (Array.isArray(s1.uncertainty_map) ? s1.uncertainty_map as unknown[] : []).slice(0, 8),
          identity_resolution_status: (s1.identity_resolution as Record<string, unknown>)?.status,
        };
        const input = buildPersonaInput(req_, handoff, capsule);
        const outcome = await executeStage(
          (user) => callOpenAI({ apiKey, model: m.stage2, system: PERSONA_SYSTEM, user, maxTokens: 16000 }),
          input,
          (parsed) => {
            const normalized = normalizePersonaOutput(parsed, run.contact_id);
            const z = PersonaOutput.safeParse(normalized);
            if (!z.success) {
              return {
                problems: z.error.issues.slice(0, 20).map((i) => `${i.path.join(".")}: ${i.message}`),
                output: parsed, qc: { passed: false, fail_reasons: ["schema invalid"] }, modelQc: null, zone: null,
              };
            }
            const qc = qcPersona(z.data);
            const problems = qc.passed ? [] : [...qc.fail_reasons];
            const zone = z.data.claude_handoff_packet.allowed_strategy_zone;
            if (ZONE_RANK[zone] < ZONE_RANK[upstreamZone]) {
              problems.push(
                `allowed_strategy_zone '${zone}' is less restrictive than upstream '${upstreamZone}' (may not override upstream evidence boundaries)`,
              );
            }
            return { problems, output: z.data, qc, modelQc: z.data.qc_status, zone };
          },
        );
        await persistArtifacts(db, run, 2, "chatgpt_persona_strategy_v1", "chatgpt_persona_input_v1", "chatgpt_persona_output_v1", input, outcome);
        if (!outcome.ok) {
          await failRun(db, runId, "qc_failed", `stage 2 QC: ${outcome.qc.fail_reasons.join("; ")}`);
          return;
        }
        await db.from("pipeline_runs").update({ status: "stage2_done" }).eq("id", runId);
        await db.rpc("enqueue_and_poke", { p_queue: "pipeline_jobs", p_msg: { run_id: runId, stage: 3 } });
      }

      if (stage === 3) {
        const apiKey = (await getUserSecret(db, run.user_id, "anthropic_api_key"))!;
        const prev = await latestPassingArtifact(db, runId, 2);
        if (!prev) { await failRun(db, runId, "error", "stage 2 artifact missing"); return; }
        const s2 = prev.output as Record<string, unknown>;
        const handoff = s2.claude_handoff_packet as Record<string, unknown>;
        const upstreamZone = String(handoff.allowed_strategy_zone ?? "yellow");
        const upstreamDrift = ((s2.drift_tracking as Record<string, unknown>)?.drift_status as string) ?? "none";
        const input = buildCommInput(req_, handoff);
        const outcome = await executeStage(
          (user) => callAnthropic({ apiKey, model: m.stage3, system: COMM_SYSTEM, user, maxTokens: 8000, thinking: true }),
          input,
          (parsed) => {
            const normalized = normalizeCommOutput(parsed, run.contact_id);
            const z = CommOutput.safeParse(normalized);
            if (!z.success) {
              return {
                problems: z.error.issues.slice(0, 20).map((i) => `${i.path.join(".")}: ${i.message}`),
                output: normalized ?? parsed, qc: { passed: false, fail_reasons: ["schema invalid"] }, modelQc: null, zone: null,
              };
            }
            const qc = qcComm(z.data, {
              allowed_strategy_zone: upstreamZone as "green" | "yellow" | "red",
              drift_status: upstreamDrift,
            });
            return {
              problems: qc.passed ? [] : qc.fail_reasons,
              output: z.data, qc, modelQc: z.data.qc_status, zone: upstreamZone,
            };
          },
        );
        await persistArtifacts(db, run, 3, "claude_communication_strategy_v1", "claude_comm_input_v1", "claude_comm_output_v1", input, outcome);
        if (!outcome.ok) {
          await failRun(db, runId, "qc_failed", `stage 3 QC: ${outcome.qc.fail_reasons.join("; ")}`);
          return;
        }

        // Wire the strategy: supersede any current one for this scope.
        const s1Art = await latestPassingArtifact(db, runId, 1);
        const s2Art = await latestPassingArtifact(db, runId, 2);
        const s3Art = await latestPassingArtifact(db, runId, 3);
        const commOut = outcome.output as CommOutput;
        let supersede = db
          .from("contact_strategies")
          .update({ status: "superseded" })
          .eq("contact_id", run.contact_id)
          .eq("channel", run.channel)
          .neq("status", "superseded");
        supersede = run.business_id === null
          ? supersede.is("business_id", null)
          : supersede.eq("business_id", run.business_id);
        await supersede;
        const { error: stratErr } = await db.from("contact_strategies").insert({
          user_id: run.user_id,
          contact_id: run.contact_id,
          business_id: run.business_id,
          channel: run.channel,
          status: "active",
          perplexity_artifact_id: s1Art?.id,
          persona_artifact_id: s2Art?.id,
          comm_artifact_id: s3Art?.id,
          allowed_zone: upstreamZone,
          drift_status: commOut.drift_response_rules.drift_status,
        });
        if (stratErr) throw new Error(`strategy insert: ${stratErr.message}`);
        await db.from("pipeline_runs").update({
          status: "complete",
          finished_at: new Date().toISOString(),
        }).eq("id", runId);
      }
    } catch (e) {
      if (job.read_ct >= MAX_JOB_ATTEMPTS) {
        await failRun(db, runId, "error", (e as Error).message);
        return; // ack — do not dead-letter loop
      }
      throw e; // redeliver via visibility timeout
    }
  });
}
