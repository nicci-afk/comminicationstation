// "Draft reply using this strategy" — user-triggered, Tier-1 priced.
// Fills a stored Claude-stage message blueprint with real thread context.
// Green/yellow allowed_zone only, per the skill's own QC rules.

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
import { draftSystem } from "./_shared/prompts.ts";

const DRAFT_MODEL = "claude-haiku-4-5";

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  const db = serviceClient();
  try {
    const { userId } = await requireUser(req, db);
    const body = await req.json();
    const itemId = body.queue_item_id as string;

    const { data: item } = await db
      .from("queue_items")
      .select("id,user_id,thread_id,contact_id,business_id,channel,title")
      .eq("id", itemId)
      .maybeSingle();
    if (!item || item.user_id !== userId) throw new HttpError(404, "queue item not found");
    if (!item.contact_id) throw new HttpError(400, "no contact on this item");

    // Strategy scope: exact business first, then contact-wide.
    let { data: strategy } = await db
      .from("contact_strategies")
      .select("id,allowed_zone,status,comm_artifact_id")
      .eq("contact_id", item.contact_id)
      .eq("business_id", item.business_id)
      .in("status", ["active", "drift_flagged"])
      .maybeSingle();
    if (!strategy) {
      const { data } = await db
        .from("contact_strategies")
        .select("id,allowed_zone,status,comm_artifact_id")
        .eq("contact_id", item.contact_id)
        .in("status", ["active", "drift_flagged"])
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      strategy = data;
    }
    if (!strategy) {
      throw new HttpError(404, "no stored strategy for this contact — run Analyze first");
    }
    if (strategy.allowed_zone === "red") {
      throw new HttpError(400,
        "this contact's strategy is red-zone (do_not_operationalize) — drafting is disabled; review the strategy instead");
    }

    const { data: artifact } = await db
      .from("pipeline_artifacts")
      .select("output")
      .eq("id", strategy.comm_artifact_id)
      .single();
    const comm = artifact!.output as Record<string, unknown>;
    const blueprints = (comm.message_blueprints as Record<string, unknown>[]) ?? [];
    if (blueprints.length === 0) throw new HttpError(400, "strategy has no message blueprints");
    const chosen = body.blueprint_name
      ? blueprints.find((b) => b.blueprint_name === body.blueprint_name)
      : blueprints[0];
    if (!chosen) throw new HttpError(404, "blueprint not found");

    const apiKey = await getUserSecret(db, userId, "anthropic_api_key");
    if (!apiKey) throw new HttpError(400, "add your Anthropic API key in Settings first");
    const spend = await checkSpend(db, userId, "draft", 0.01);
    if (!spend.allowed) throw new HttpError(402, `spend cap: ${spend.reason}`);

    const { data: msgs } = await db
      .from("messages")
      .select("direction,from_name,from_identifier,snippet,body_text,sent_at")
      .eq("thread_id", item.thread_id)
      .order("sent_at", { ascending: false })
      .limit(6);
    const context = (msgs ?? []).reverse().map((m) => ({
      direction: m.direction,
      from: m.from_name || m.from_identifier,
      at: m.sent_at,
      text: (m.body_text ?? m.snippet ?? "").slice(0, 1500),
    }));

    const result = await callAnthropic({
      apiKey,
      model: DRAFT_MODEL,
      system: draftSystem(),
      maxTokens: 1200,
      user: JSON.stringify({
        channel: item.channel,
        subject: item.title,
        blueprint: chosen,
        tone_profile: comm.tone_profile,
        language_do: comm.language_do,
        language_avoid: comm.language_avoid,
        opening_options: comm.opening_options,
        conversation: context,
      }),
    });
    const parsed = result.parsed as { draft?: string; notes?: string };
    if (!parsed.draft) throw new Error("model returned no draft");

    const { data: saved, error } = await db
      .from("reply_drafts")
      .insert({
        user_id: userId,
        queue_item_id: itemId,
        strategy_id: strategy.id,
        blueprint_name: String(chosen.blueprint_name ?? ""),
        draft_text: parsed.draft,
        confidence: (chosen.confidence as string) === "green" ? "green" : "yellow",
        cost_usd: result.costUsd,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    await recordSpend(db, {
      userId,
      provider: result.provider,
      model: result.model,
      purpose: "draft",
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
      refType: "reply_draft",
      refId: saved.id,
    });

    return json({ draft: parsed.draft, notes: parsed.notes ?? "", draft_id: saved.id });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
}
