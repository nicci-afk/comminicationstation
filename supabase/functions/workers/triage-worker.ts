// Tier-1 triage retains the deterministic result when no paid work is allowed.
// Budget/policy/unknown-result blocks are visible errors, retained by queue retries
// and the existing dead-letter path. Never repeat an unverified paid attempt.

import { handleOptions, runWorker, getUserSecret } from "./_shared/util.ts";
import { canonicalJson, runBudgetedTriage } from "./triage-cost.ts";
import { triageSystem } from "./_shared/prompts.ts";
import { maybePushToAgentedge } from "./_shared/agentedge-push.ts";


export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  return await runWorker(req, "triage_jobs", 60, 100_000, async (db, job) => {
    const messageId = job.message.message_id as string;
    const { data: msg, error: messageError } = await db
      .from("messages")
      .select("id,user_id,from_name,from_identifier,to_identifiers,subject,snippet,headers,channel")
      .eq("id", messageId)
      .maybeSingle();
    if (messageError) throw new Error("triage cost: message read failed");
    if (!msg) return;

    const apiKey = await getUserSecret(db, msg.user_id, "anthropic_api_key");
    if (!apiKey) return; // no key yet — rules-only triage already applied

    const { data: businesses, error: businessError } = await db
      .from("businesses")
      .select("id,name")
      .eq("user_id", msg.user_id)
      .order("id");
    if (businessError || !businesses) throw new Error("triage cost: business context unverified");

    const result = await runBudgetedTriage(db, {
      userId: msg.user_id,
      messageId,
      apiKey,
      businesses,
      system: triageSystem(businesses),
      user: canonicalJson({
        from_name: msg.from_name,
        from_email: msg.from_identifier,
        to: msg.to_identifiers,
        subject: msg.subject,
        snippet: msg.snippet,
        headers: msg.headers,
        channel: msg.channel,
      }),
    });

    // Preserve the separately contained AgentEdge path, and do not repeat it
    // when a queue redelivery finds this task already applied.
    if (result.applied) {
      await maybePushToAgentedge(db, msg.user_id, messageId, result.category);
    }
  });
}
