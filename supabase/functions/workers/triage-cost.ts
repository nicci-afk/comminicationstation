// A task-local verified result receipt, not a cross-message context cache.
import type { SupabaseClient } from "@supabase/supabase-js";
import { callTriageOnce, type TriageUsage } from "./triage-provider.ts";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("triage cost: source value is not JSON");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export async function triageRequestHash(system: string, user: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({
    version: "triage-cost-v1", system, user, max_tokens: 400,
  }));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function rpc(db: SupabaseClient, name: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(name, args);
  if (error || !data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`triage cost: ${name} failed; paid work not retried`);
  }
  return data as Record<string, unknown>;
}

const categories = new Set(["booking", "bdm", "possible_supplier", "lead", "agent_to_agent", "lender", "title",
  "needs_reply", "receipt", "scheduling", "urgent", "fyi", "promotion", "newsletter", "notification", "expense", "other"]);
export function verifiedDecision(value: Record<string, unknown> | null): boolean {
  return value !== null && typeof value.category === "string" && categories.has(value.category) &&
    typeof value.needs_reply === "boolean" &&
    ["human", "automated", "organization", "unknown"].includes(String(value.contact_kind)) &&
    (value.business_id === null || typeof value.business_id === "string") &&
    typeof value.priority === "number" && Number.isFinite(value.priority) &&
    typeof value.reason === "string" && value.reason.trim().length > 0;
}

export async function runBudgetedTriage(
  db: SupabaseClient,
  args: { userId: string; messageId: string; apiKey: string; system: string; user: string;
    businesses: { id: string; name: string }[] },
  call: typeof callTriageOnce = callTriageOnce,
): Promise<{ applied: boolean; category: string }> {
  const requestHash = await triageRequestHash(args.system, args.user);
  const identity = { p_user: args.userId, p_message: args.messageId, p_request_hash: requestHash };
  const reserved = await rpc(db, "reserve_triage_cost_v1", { ...identity,
    p_source: { message: JSON.parse(args.user), businesses: args.businesses } });
  if (reserved.status === "applied") return { applied: false, category: "" };
  if (reserved.status !== "reserved" && reserved.status !== "ready") {
    throw new Error(`triage cost blocked: ${String(reserved.reason ?? "unknown budget state")}`);
  }
  if (reserved.status === "reserved") {
    if (typeof reserved.token !== "string" || typeof reserved.model !== "string" ||
        typeof reserved.valid_until !== "string" ||
        !Number.isFinite(Date.parse(reserved.valid_until)) || Date.parse(reserved.valid_until) <= Date.now()) {
      throw new Error("triage cost: invalid or expired reservation; paid work not started");
    }
    let result: TriageUsage;
    try {
      result = await call({ apiKey: args.apiKey, model: reserved.model,
        system: args.system, user: args.user });
    } catch {
      // No raw provider exception, prompt or secret is persisted/logged here.
      // A missing or failed update still leaves the original reservation held.
      await rpc(db, "mark_triage_unknown_v1", { ...identity, p_token: reserved.token })
        .catch(() => undefined);
      throw new Error("triage cost: provider outcome unknown; reservation retained, no automatic paid retry");
    }
    const decision = result.decision;
    const category = decision && typeof decision.category === "string" ? decision.category : null;
    const appliedDecision = verifiedDecision(decision) && decision ? {
      business_id: args.businesses.some(b => b.id === decision.business_id) ? decision.business_id : null,
      category,
      needs_reply: decision.needs_reply === true,
      contact_kind: decision.contact_kind ?? null,
      priority: typeof decision.priority === "number" && Number.isFinite(decision.priority)
        ? Math.max(0, Math.min(100, Math.round(decision.priority))) : null,
      reason: String(decision.reason ?? "model triage"),
    } : null;
    const settled = await rpc(db, "settle_triage_cost_v1", { ...identity,
      p_token: reserved.token, p_model: result.model,
      p_tokens_in: result.tokensIn, p_tokens_out: result.tokensOut, p_decision: appliedDecision });
    if (settled.status !== "ready") {
      throw new Error(`triage cost blocked: ${String(settled.reason ?? "unverified result")}`);
    }
  }
  const applied = await rpc(db, "apply_budgeted_triage_v1", identity);
  if (applied.status !== "applied") throw new Error("triage cost: application unverified; paid work not retried");
  return { applied: applied.newly_applied === true,
    category: typeof applied.category === "string" ? applied.category : "" };
}
