// POST { source_contact_id, target_contact_id }
// Full contact merge: folds the source contact into the target by:
// 1. Moving all contact_channels from source → target
//    (channels already on target are deduplicated — the source duplicate is deleted).
// 2. Updating every queue_item that referenced the source to reference the target,
//    with the target's display_name as sender_name.
// 3. Updating every message that referenced the source to reference the target.
// 4. Tombstoning the source by setting merged_into_contact_id = target, so it is
//    excluded from all normal queries but preserved for audit purposes.

import { handleOptions, HttpError, json, requireUser, serviceClient } from "./_shared/util.ts";

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  const db = serviceClient();
  try {
    const { userId } = await requireUser(req, db);
    const { source_contact_id, target_contact_id } = await req.json() as {
      source_contact_id?: string;
      target_contact_id?: string;
    };
    if (!source_contact_id) throw new HttpError(400, "source_contact_id required");
    if (!target_contact_id) throw new HttpError(400, "target_contact_id required");
    if (source_contact_id === target_contact_id) throw new HttpError(400, "source and target must be different");

    // Verify both contacts belong to this user.
    const [{ data: source, error: srcErr }, { data: target, error: tgtErr }] = await Promise.all([
      db.from("contacts").select("id, display_name, kind").eq("id", source_contact_id).eq("user_id", userId).maybeSingle(),
      db.from("contacts").select("id, display_name").eq("id", target_contact_id).eq("user_id", userId).maybeSingle(),
    ]);
    if (srcErr) throw new Error(srcErr.message);
    if (tgtErr) throw new Error(tgtErr.message);
    if (!source) throw new HttpError(404, "Source contact not found");
    if (!target) throw new HttpError(404, "Target contact not found");

    const displayName = (target as { display_name: string }).display_name;

    // 1. Move each channel from source → target.
    //    A unique constraint on (user_id, channel_type, canonical_value) prevents duplicate channels.
    //    When the target already has the same channel, just delete the source's copy.
    const { data: sourceChannels, error: chListErr } = await db
      .from("contact_channels")
      .select("id, channel_type, canonical_value")
      .eq("contact_id", source_contact_id)
      .eq("user_id", userId);
    if (chListErr) throw new Error(chListErr.message);

    let channelsMoved = 0;
    let channelsDeduplicated = 0;
    for (const ch of sourceChannels ?? []) {
      const { error: moveErr } = await db
        .from("contact_channels")
        .update({ contact_id: target_contact_id })
        .eq("id", (ch as { id: string }).id);
      if (moveErr) {
        if (moveErr.code === "23505") {
          // Target already has this channel — delete the source duplicate.
          await db.from("contact_channels").delete().eq("id", (ch as { id: string }).id);
          channelsDeduplicated++;
        } else {
          throw new Error(moveErr.message);
        }
      } else {
        channelsMoved++;
      }
    }

    // 2. Re-point all queue_items from source → target.
    const { error: qiErr } = await db
      .from("queue_items")
      .update({ contact_id: target_contact_id, sender_name: displayName })
      .eq("user_id", userId)
      .eq("contact_id", source_contact_id);
    if (qiErr) throw new Error(qiErr.message);

    // 3. Re-point all messages from source → target.
    const { error: msgErr } = await db
      .from("messages")
      .update({ contact_id: target_contact_id })
      .eq("user_id", userId)
      .eq("contact_id", source_contact_id);
    if (msgErr) throw new Error(msgErr.message);

    // 4. Tombstone the source so it is invisible to normal queries but auditable.
    const { error: tombErr } = await db
      .from("contacts")
      .update({ merged_into_contact_id: target_contact_id })
      .eq("id", source_contact_id)
      .eq("user_id", userId);
    if (tombErr) throw new Error(tombErr.message);

    return json({
      ok: true,
      source_contact_id,
      target_contact_id,
      display_name: displayName,
      channels_moved: channelsMoved,
      channels_deduplicated: channelsDeduplicated,
    });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
}
