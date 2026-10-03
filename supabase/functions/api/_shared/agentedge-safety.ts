// MCC -> AgentEdge containment only. Call after authentication and before any
// AgentEdge secret lookup, extraction/model call, or destination request.
// No cache: a later invocation must see the latest tenant control row.
import type { SupabaseClient } from "@supabase/supabase-js";

export type AgentedgeWritePolicy =
  | { allowed: true }
  | {
    allowed: false;
    status: "paused";
    reason:
      | "safety_controls_unavailable"
      | "safety_controls_missing"
      | "safety_controls_invalid"
      | "emergency_stop"
      | "automation_database_writes_disabled";
  };

export async function agentedgeWritePolicy(
  db: SupabaseClient,
  userId: string,
): Promise<AgentedgeWritePolicy> {
  if (!userId) {
    return { allowed: false, status: "paused", reason: "safety_controls_invalid" };
  }
  try {
    const { data, error } = await db
      .from("mcc_safety_controls")
      .select("user_id,emergency_stop,automation_database_writes_enabled")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      return { allowed: false, status: "paused", reason: "safety_controls_unavailable" };
    }
    if (!data) {
      return { allowed: false, status: "paused", reason: "safety_controls_missing" };
    }
    if (data.user_id !== userId) {
      return { allowed: false, status: "paused", reason: "safety_controls_invalid" };
    }
    if (data.emergency_stop !== false) {
      return { allowed: false, status: "paused", reason: "emergency_stop" };
    }
    if (data.automation_database_writes_enabled !== true) {
      return { allowed: false, status: "paused", reason: "automation_database_writes_disabled" };
    }
    return { allowed: true };
  } catch {
    // Do not leak raw database errors, and never fall back to enabled behavior.
    return { allowed: false, status: "paused", reason: "safety_controls_unavailable" };
  }
}
