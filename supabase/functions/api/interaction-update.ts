// Authors and applies post_interaction_update_packet (interaction_update_v1)
// entries — the ONLY mechanism that evolves a stored strategy between pipeline
// runs. Re-analysis is RECOMMENDED (flagged), never auto-run, per the user's
// manual-trigger-only decision; the flag conditions come from the packet's own
// signals (drift observed, repeated confidence decrease), per the skills.

import {
  checkSpend,
  getUserSecret,
  handleOptions,
  HttpError,
  json,
  recordSpend,
  requireUser,
  serviceClient,
} from "./_shared/util.ts";
import { callAnthropic } from "./_shared/llm.ts";
import { interactionUpdateSystem } from "./_shared/prompts.ts";
import { PostInteractionUpdatePacket } from "./_shared/schemas/comm.ts";

const UPDATE_MODEL = "claude-haiku-4-5";

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  const db = serviceClient();
  try {
    const { userId } = await requireUser(req, db);
    const body = await req.json();
    const strategyId = body.strategy_id as string;
    const mode = (body.mode as string) ?? "manual";

    const { data: strategy } = await db
      .from("contact_strategies")
      .select("id,user_id,contact_id,status,drift_status")
      .eq("id", strategyId)
      .maybeSingle();
    if (!strategy || strategy.user_id !== userId) throw new HttpError(404, "strategy not found");

    let packet: unknown;
    let authoredBy = "user";
    let costUsd = 0;

    if (mode === "manual") {
      packet = { update_schema_version: "interaction_update_v1", ...body.packet };
    } else {
      // auto: observe the exchange on a queue item and let Haiku author it
      const itemId = body.queue_item_id as string;
      const { data: item } = await db
        .from("queue_items")
        .select("id,user_id,thread_id,resolved_by_message_id,resolved_at")
        .eq("id", itemId)
        .maybeSingle();
      if (!item || item.user_id !== userId) throw new HttpError(404, "queue item not found");
      if (!item.resolved_by_message_id) {
        throw new HttpError(400, "no observed reply on this item yet — use manual mode");
      }
      const { data: sent } = await db
        .from("messages")
        .select("snippet,body_text,sent_at")
        .eq("id", item.resolved_by_message_id)
        .single();
      const { data: responseMsg } = await db
        .from("messages")
        .select("snippet,body_text,sent_at")
        .eq("thread_id", item.thread_id)
        .eq("direction", "inbound")
        .gt("sent_at", sent!.sent_at)
        .order("sent_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      const apiKey = await getUserSecret(db, userId, "anthropic_api_key");
      if (!apiKey) throw new HttpError(400, "add your Anthropic API key in Settings first");
      const spend = await checkSpend(db, userId, "interaction_update", 0.005);
      if (!spend.allowed) throw new HttpError(402, `spend cap: ${spend.reason}`);

      const result = await callAnthropic({
        apiKey,
        model: UPDATE_MODEL,
        system: interactionUpdateSystem(),
        maxTokens: 700,
        user: JSON.stringify({
          what_was_sent: (sent!.body_text ?? sent!.snippet ?? "").slice(0, 2000),
          response_observed: responseMsg
            ? (responseMsg.body_text ?? responseMsg.snippet ?? "").slice(0, 2000)
            : "no response observed yet",
        }),
      });
      packet = result.parsed;
      authoredBy = "model";
      costUsd = result.costUsd;
      await recordSpend(db, {
        userId,
        provider: result.provider,
        model: result.model,
        purpose: "interaction_update",
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        costUsd: result.costUsd,
        refType: "strategy",
        refId: strategyId,
      });
    }

    const validated = PostInteractionUpdatePacket.safeParse(packet);
    if (!validated.success) {
      throw new HttpError(
        400,
        `packet failed interaction_update_v1 validation: ${validated.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }

    const { error: insErr } = await db.from("interaction_updates").insert({
      user_id: userId,
      contact_id: strategy.contact_id,
      strategy_id: strategyId,
      queue_item_id: (body.queue_item_id as string) ?? null,
      packet: validated.data,
      authored_by: authoredBy,
      cost_usd: costUsd,
    });
    if (insErr) throw new Error(insErr.message);

    // Escalation per the schemas' own signals — no invented triggers.
    const p = validated.data;
    let driftStatus = strategy.drift_status as string;
    let recommend = false;
    let reason = "";
    if (p.drift_signals_observed.length > 0) {
      driftStatus = driftStatus === "none" ? "possible" : driftStatus;
      recommend = true;
      reason = "drift signals observed in post-interaction updates";
    } else {
      const { data: recent } = await db
        .from("interaction_updates")
        .select("packet")
        .eq("strategy_id", strategyId)
        .order("created_at", { ascending: false })
        .limit(3);
      const decreases = (recent ?? []).filter(
        (r) => (r.packet as { confidence_change?: string }).confidence_change === "decrease",
      ).length;
      if (decreases >= 2) {
        recommend = true;
        reason = "confidence decreased across repeated interactions";
      }
    }
    if (recommend) {
      await db
        .from("contact_strategies")
        .update({
          status: "drift_flagged",
          drift_status: driftStatus,
          re_analysis_recommended: true,
          re_analysis_reason: reason,
        })
        .eq("id", strategyId);
    }

    return json({
      ok: true,
      packet: validated.data,
      re_analysis_recommended: recommend,
      reason,
    });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
}
