// POST { queue_item_id } — Marks a sender as blocked:
// 1. Upserts a from_email triage rule with action='suppress' so future
//    messages from this sender land suppressed at ingest time.
// 2. Suppresses all open queue items from this sender in one pass
//    (covers the current item plus any others already in the queue).

import { handleOptions, HttpError, json, requireUser, serviceClient } from "./_shared/util.ts";

const OPEN_STATES = ["new", "needs_attention", "fyi", "backlog", "snoozed", "awaiting_reply"];

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  const db = serviceClient();
  try {
    const { userId } = await requireUser(req, db);
    const { queue_item_id } = await req.json() as { queue_item_id?: string };
    if (!queue_item_id) throw new HttpError(400, "queue_item_id required");

    const { data: item, error: itemErr } = await db
      .from("queue_items")
      .select("id, sender_identifier, sender_name")
      .eq("id", queue_item_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (itemErr) throw new Error(itemErr.message);
    if (!item) throw new HttpError(404, "Queue item not found");

    const sender = (item as { sender_identifier: string }).sender_identifier;
    if (!sender) throw new HttpError(400, "Queue item has no sender identifier");

    // Create (or update) the block rule for this sender.
    const { error: ruleErr } = await db.from("triage_rules").upsert(
      {
        user_id: userId,
        rule_type: "from_email",
        pattern: sender,
        action: "suppress",
        enabled: true,
        source: "user",
      },
      { onConflict: "user_id,rule_type,pattern" },
    );
    if (ruleErr) throw new Error(ruleErr.message);

    // Suppress every open item from this sender in one update.
    const { data: suppressed, error: suppErr } = await db
      .from("queue_items")
      .update({ state: "suppressed" })
      .eq("user_id", userId)
      .eq("sender_identifier", sender)
      .in("state", OPEN_STATES)
      .select("id");
    if (suppErr) throw new Error(suppErr.message);

    return json({
      ok: true,
      sender,
      items_suppressed: (suppressed as { id: string }[] | null)?.length ?? 0,
    });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
}
