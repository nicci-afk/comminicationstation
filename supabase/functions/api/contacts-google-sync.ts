// POST { gmail_account_id: string }
// Fetches the user's Google Contacts via People API using the stored OAuth
// token for the named Gmail account, then upserts contacts + contact_channels.
// Auth: user JWT. Requires the gmail_account to have been authorised with the
// contacts.readonly scope (prompted on reconnect after that scope was added).

import { handleOptions, HttpError, json, requireUser, serviceClient } from "./_shared/util.ts";
import { accessTokenForAccount, type GmailAccountRow } from "./_shared/gmail.ts";

interface PersonConnection {
  names?: { displayName?: string }[];
  emailAddresses?: { value?: string }[];
  phoneNumbers?: { value?: string }[];
}

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  const db = serviceClient();
  try {
    const { userId } = await requireUser(req, db);
    const { gmail_account_id } = await req.json() as { gmail_account_id?: string };
    if (!gmail_account_id) throw new HttpError("missing gmail_account_id", 400);

    // Verify ownership and fetch full row for token refresh.
    const { data: account } = await db
      .from("gmail_accounts")
      .select("*")
      .eq("id", gmail_account_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!account) throw new HttpError("gmail account not found", 404);

    const accessToken = await accessTokenForAccount(db, account as GmailAccountRow);

    // Paginate through all connections.
    const connections: PersonConnection[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL("https://people.googleapis.com/v1/people/me/connections");
      url.searchParams.set("personFields", "names,emailAddresses,phoneNumbers");
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (res.status === 401 || res.status === 403) {
        throw new HttpError(
          "Google Contacts access denied. Reconnect your Gmail account (Settings → Gmail → Disconnect → Reconnect) to grant Contacts access.",
          403
        );
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`People API error ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = await res.json() as { connections?: PersonConnection[]; nextPageToken?: string };
      if (data.connections) connections.push(...data.connections);
      pageToken = data.nextPageToken;
    } while (pageToken);

    // Pre-fetch existing email channels for efficient lookup.
    const { data: existingChannels } = await db
      .from("contact_channels")
      .select("canonical_value, contact_id")
      .eq("user_id", userId)
      .eq("channel_type", "email")
      .limit(20000);

    const emailToContactId = new Map<string, string>();
    for (const ch of existingChannels ?? []) {
      emailToContactId.set(ch.canonical_value as string, ch.contact_id as string);
    }

    let imported = 0, updated = 0, skipped = 0;
    const errors: string[] = [];

    for (const conn of connections) {
      try {
        const displayName = conn.names?.[0]?.displayName?.trim() ?? "";
        const emails = (conn.emailAddresses ?? [])
          .map((e) => e.value?.toLowerCase().trim())
          .filter((e): e is string => !!e && e.includes("@"));
        const phones = (conn.phoneNumbers ?? [])
          .map((p) => p.value?.replace(/[\s\-\(\)\.]/g, ""))
          .filter((p): p is string => !!p && p.length > 3);

        if (!displayName && emails.length === 0) { skipped++; continue; }

        let contactId: string | null = null;
        for (const email of emails) {
          const found = emailToContactId.get(email);
          if (found) { contactId = found; break; }
        }

        if (contactId) {
          if (displayName) {
            await db.from("contacts")
              .update({ display_name: displayName, kind: "human" })
              .eq("id", contactId).eq("user_id", userId);
          }
          updated++;
        } else {
          const { data: created, error: ce } = await db
            .from("contacts")
            .insert({ user_id: userId, display_name: displayName || emails[0] || "Unknown", kind: "human" })
            .select("id").single();
          if (ce) throw new Error(ce.message);
          contactId = created.id as string;
          for (const email of emails) emailToContactId.set(email, contactId);
          imported++;
        }

        for (const email of emails) {
          await db.from("contact_channels").upsert(
            { contact_id: contactId, user_id: userId, channel_type: "email", canonical_value: email },
            { onConflict: "user_id,channel_type,canonical_value", ignoreDuplicates: true }
          );
        }
        for (const phone of phones) {
          await db.from("contact_channels").upsert(
            { contact_id: contactId, user_id: userId, channel_type: "phone", canonical_value: phone },
            { onConflict: "user_id,channel_type,canonical_value", ignoreDuplicates: true }
          );
        }
      } catch (e) {
        skipped++;
        errors.push(`${conn.names?.[0]?.displayName ?? "?"}: ${(e as Error).message}`);
      }
    }

    return json({ total: connections.length, imported, updated, skipped, errors: errors.slice(0, 20) });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
}
