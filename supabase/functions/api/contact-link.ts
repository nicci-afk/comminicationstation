// POST { queue_item_id, contact_id }
// Links a sender (email address or phone number) to an existing known contact by:
// 1. Re-pointing the sender's contact_channels row(s) to the target contact.
// 2. Updating every queue_item from this sender to reference the target contact
//    and display the contact's display_name as sender_name.
// 3. Updating every message from this sender to reference the target contact.
// 4. Deleting the auto-created placeholder contact if it had kind='unknown'
//    and now has no remaining channels.

import { handleOptions, HttpError, json, requireUser, serviceClient } from "./_shared/util.ts";

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  const db = serviceClient();
  try {
    const { userId } = await requireUser(req, db);
    const { queue_item_id, contact_id: targetContactId } = await req.json() as {
      queue_item_id?: string;
      contact_id?: string;
    };
    if (!queue_item_id) throw new HttpError(400, "queue_item_id required");
    if (!targetContactId) throw new HttpError(400, "contact_id required");

    // Verify the target contact belongs to this user.
    const { data: targetContact, error: tcErr } = await db
      .from("contacts")
      .select("id, display_name")
      .eq("id", targetContactId)
      .eq("user_id", userId)
      .maybeSingle();
    if (tcErr) throw new Error(tcErr.message);
    if (!targetContact) throw new HttpError(404, "Contact not found");

    // Get the queue item to find sender_identifier, channel, and current contact_id.
    const { data: item, error: itemErr } = await db
      .from("queue_items")
      .select("id, sender_identifier, channel, contact_id")
      .eq("id", queue_item_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (itemErr) throw new Error(itemErr.message);
    if (!item) throw new HttpError(404, "Queue item not found");

    const sender = (item as { sender_identifier: string }).sender_identifier;
    const oldContactId = (item as { contact_id: string | null }).contact_id;
    const channel = (item as { channel: string }).channel;

    if (!sender) throw new HttpError(400, "Queue item has no sender identifier");
    if (targetContactId === oldContactId) {
      throw new HttpError(400, "Sender is already linked to this contact");
    }

    const channelType = channel === "email" ? "email" : "phone";
    const displayName = (targetContact as { display_name: string }).display_name;

    // 1. Re-point the contact_channels row(s) for this sender to the target contact.
    const { error: chErr } = await db
      .from("contact_channels")
      .update({ contact_id: targetContactId })
      .eq("user_id", userId)
      .eq("channel_type", channelType)
      .eq("canonical_value", sender);
    if (chErr) throw new Error(chErr.message);

    // 2. Update every queue_item from this sender.
    const { error: qiErr } = await db
      .from("queue_items")
      .update({ contact_id: targetContactId, sender_name: displayName })
      .eq("user_id", userId)
      .eq("sender_identifier", sender);
    if (qiErr) throw new Error(qiErr.message);

    // 3. Update every message from this sender.
    const { error: msgErr } = await db
      .from("messages")
      .update({ contact_id: targetContactId })
      .eq("user_id", userId)
      .eq("from_identifier", sender);
    if (msgErr) throw new Error(msgErr.message);

    // 4. If the old placeholder contact was auto-created (kind='unknown') and now
    //    has no remaining channels, delete it so it doesn't clutter the contacts list.
    if (oldContactId && oldContactId !== targetContactId) {
      const { data: oldContact } = await db
        .from("contacts")
        .select("kind")
        .eq("id", oldContactId)
        .eq("user_id", userId)
        .maybeSingle();
      if (oldContact && (oldContact as { kind: string }).kind === "unknown") {
        const { data: remaining } = await db
          .from("contact_channels")
          .select("id")
          .eq("contact_id", oldContactId)
          .limit(1);
        if (!remaining?.length) {
          await db.from("contacts").delete().eq("id", oldContactId).eq("user_id", userId);
        }
      }
    }

    return json({ ok: true, sender, contact: { id: targetContactId, display_name: displayName } });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
}
