// Tier-1 triage: one cheap Haiku call for messages the deterministic rules
// couldn't categorize. Capped per user per day; falls back silently to the
// rules-only result when keys or budget are missing.

import { handleOptions, runWorker, checkSpend, recordSpend, getUserSecret } from "./_shared/util.ts";
import { callAnthropic } from "./_shared/llm.ts";
import { triageSystem } from "./_shared/prompts.ts";

const TRIAGE_MODEL = "claude-haiku-4-5";

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  return await runWorker(req, "triage_jobs", 60, 100_000, async (db, job) => {
    const messageId = job.message.message_id as string;
    const { data: msg } = await db
      .from("messages")
      .select("id,user_id,from_name,from_identifier,to_identifiers,subject,snippet,headers,channel")
      .eq("id", messageId)
      .maybeSingle();
    if (!msg) return;

    const apiKey = await getUserSecret(db, msg.user_id, "anthropic_api_key");
    if (!apiKey) return; // no key yet — rules-only triage already applied

    const spend = await checkSpend(db, msg.user_id, "triage", 0.002);
    if (!spend.allowed) return; // hard cap: never queue up spend

    const { data: businesses } = await db
      .from("businesses")
      .select("id,name")
      .eq("user_id", msg.user_id);

    const result = await callAnthropic({
      apiKey,
      model: TRIAGE_MODEL,
      system: triageSystem(businesses ?? []),
      maxTokens: 400,
      user: JSON.stringify({
        from_name: msg.from_name,
        from_email: msg.from_identifier,
        to: msg.to_identifiers,
        subject: msg.subject,
        snippet: msg.snippet,
        headers: msg.headers,
        channel: msg.channel,
      }),
    });

    const decision = result.parsed as Record<string, unknown>;
    const validBusiness = (businesses ?? []).some((b) => b.id === decision.business_id);
    const { error } = await db.rpc("apply_model_triage", {
      p_message_id: messageId,
      p: {
        business_id: validBusiness ? decision.business_id : null,
        category: decision.category ?? null,
        needs_reply: decision.needs_reply === true,
        contact_kind: decision.contact_kind ?? null,
        priority: typeof decision.priority === "number"
          ? Math.max(0, Math.min(100, decision.priority))
          : null,
        reason: String(decision.reason ?? "model triage"),
      },
    });
    if (error) throw new Error(error.message);

    await recordSpend(db, {
      userId: msg.user_id,
      provider: result.provider,
      model: result.model,
      purpose: "triage",
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
      refType: "message",
      refId: messageId,
    });
  });
}
