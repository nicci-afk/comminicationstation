// POST { vcf_content: string }
// Parses a vCard (.vcf) file and upserts contacts + contact_channels.
// Auth: user JWT.

import { handleOptions, HttpError, json, requireUser, serviceClient } from "./_shared/util.ts";

interface ParsedContact {
  displayName: string;
  emails: string[];
  phones: string[];
}

function decodeVCardValue(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function parseVCard(text: string): ParsedContact[] {
  const results: ParsedContact[] = [];
  const blocks = text.split(/BEGIN:VCARD/i).slice(1);
  for (const block of blocks) {
    const end = block.indexOf("END:VCARD");
    const card = end >= 0 ? block.slice(0, end) : block;
    // Unfold folded lines (CRLF + whitespace = continuation)
    const unfolded = card.replace(/\r?\n[ \t]/g, "");
    const lines = unfolded.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    let displayName = "";
    const emails: string[] = [];
    const phones: string[] = [];

    for (const line of lines) {
      const ci = line.indexOf(":");
      if (ci < 0) continue;
      const key = line.slice(0, ci).toUpperCase();
      const value = line.slice(ci + 1).trim();
      if (!value) continue;

      if (key === "FN" || key.startsWith("FN;")) {
        displayName = decodeVCardValue(value);
      } else if ((key === "N" || key.startsWith("N;")) && !displayName) {
        const parts = value.split(";");
        const last = decodeVCardValue(parts[0] ?? "");
        const first = decodeVCardValue(parts[1] ?? "");
        displayName = [first, last].filter(Boolean).join(" ");
      } else if (key.startsWith("EMAIL")) {
        const email = decodeVCardValue(value).toLowerCase().trim();
        if (email.includes("@") && !emails.includes(email)) emails.push(email);
      } else if (key.startsWith("TEL")) {
        const phone = decodeVCardValue(value).replace(/[\s\-\(\)\.]/g, "");
        if (phone && !phones.includes(phone)) phones.push(phone);
      }
    }

    if (displayName || emails.length > 0) {
      results.push({ displayName: displayName || emails[0] || "Unknown", emails, phones });
    }
  }
  return results;
}

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  const db = serviceClient();
  try {
    const { userId } = await requireUser(req, db);
    const body = await req.json() as { vcf_content?: string };
    if (!body.vcf_content?.trim()) throw new HttpError(400, "missing vcf_content");

    const contacts = parseVCard(body.vcf_content);
    if (contacts.length === 0) throw new HttpError(400, "no vCard records found");

    // Pre-fetch all existing email channels for this user to avoid per-contact queries.
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

    for (const c of contacts) {
      try {
        // Find existing contact by first matching email.
        let contactId: string | null = null;
        for (const email of c.emails) {
          const found = emailToContactId.get(email);
          if (found) { contactId = found; break; }
        }

        if (contactId) {
          await db.from("contacts")
            .update({ display_name: c.displayName, kind: "human" })
            .eq("id", contactId).eq("user_id", userId);
          updated++;
        } else {
          const { data: created, error: ce } = await db
            .from("contacts")
            .insert({ user_id: userId, display_name: c.displayName, kind: "human" })
            .select("id").single();
          if (ce) throw new Error(ce.message);
          contactId = created.id as string;
          // Update the local map so subsequent contacts sharing this email are found.
          for (const email of c.emails) emailToContactId.set(email, contactId);
          imported++;
        }

        for (const email of c.emails) {
          await db.from("contact_channels").upsert(
            { contact_id: contactId, user_id: userId, channel_type: "email", canonical_value: email },
            { onConflict: "user_id,channel_type,canonical_value", ignoreDuplicates: true }
          );
        }
        for (const phone of c.phones) {
          await db.from("contact_channels").upsert(
            { contact_id: contactId, user_id: userId, channel_type: "phone", canonical_value: phone },
            { onConflict: "user_id,channel_type,canonical_value", ignoreDuplicates: true }
          );
        }
      } catch (e) {
        skipped++;
        errors.push(`${c.displayName}: ${(e as Error).message}`);
      }
    }

    return json({ total: contacts.length, imported, updated, skipped, errors: errors.slice(0, 20) });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
}
