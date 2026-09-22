// POST {} — merges contacts from the user's AgentEdge CRM into the command center.
// Requires 'agentedge_service_key' stored via Settings → API keys.
// Uses ingest_agentedge_contacts RPC (service-role only) for batch merge.

import { getUserSecret, handleOptions, HttpError, json, requireUser, serviceClient } from "./_shared/util.ts";

const AGENTEDGE_URL = "https://iitrvppynxisvhztbybw.supabase.co";
const PAGE_SIZE = 500;

// Use Record to accept any column layout from AgentEdge
type CrmClient = Record<string, unknown>;

interface NormalizedContact {
  display_name: string;
  birthday: string | null;
  notes: string;
  emails: string[];
  phones: string[];
  address: string | null;
}

function pick(obj: CrmClient, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function pickArr(obj: CrmClient, ...keys: string[]): string[] {
  for (const k of keys) {
    const v = obj[k];
    if (Array.isArray(v)) return v.map(String);
  }
  return [];
}

function normalize(clients: CrmClient[]): NormalizedContact[] {
  return clients
    .map((c) => {
      // Try dedicated full-name columns first; fall back to first+last combination.
      // "first_name" is intentionally excluded from the first pick() so the
      // IIFE that joins first+last always runs when there is no dedicated full-name field.
      const name = pick(c, "display_name", "full_name", "name", "client_name") || (() => {
        const fn = pick(c, "first_name");
        const ln = pick(c, "last_name", "surname");
        return [fn, ln].filter(Boolean).join(" ");
      })();

      const email = pick(c, "email", "primary_email", "email_address");
      const altEmails = pickArr(c, "alt_emails", "additional_emails", "other_emails");
      const phone = pick(c, "phone", "primary_phone", "phone_number", "mobile");
      const altPhones = pickArr(c, "alt_phones", "additional_phones", "other_phones");
      const dob = pick(c, "date_of_birth", "birthday", "dob") || null;
      const notes = pick(c, "notes", "note", "description", "comments");

      // Build a single-line address from whatever columns AgentEdge provides
      const formattedAddress = pick(c, "full_address", "formatted_address", "address");
      const street = pick(c, "street_address", "address_line1", "address_line_1", "street");
      const city = pick(c, "city");
      const state = pick(c, "state", "state_province", "province");
      const zip = pick(c, "zip", "postal_code", "zip_code", "postcode");
      const country = pick(c, "country", "country_code");
      const address = formattedAddress ||
        [street, city, [state, zip].filter(Boolean).join(" "), country].filter(Boolean).join(", ") ||
        null;

      const emails = [
        ...(email ? [email.toLowerCase()] : []),
        ...altEmails.map((e) => e.toLowerCase().trim()),
      ].filter((e) => e.includes("@"));
      const phones = [
        ...(phone ? [phone] : []),
        ...altPhones.map((p) => p.trim()),
      ].filter(Boolean);

      return { display_name: name, birthday: dob ?? null, notes, emails: [...new Set(emails)], phones: [...new Set(phones)], address };
    })
    .filter((c) => c.display_name.length > 0 && !/^[\d\s+\-().]+$/.test(c.display_name));
}

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  const db = serviceClient();
  try {
    const { userId } = await requireUser(req, db);

    const agentedgeKey = await getUserSecret(db, userId, "agentedge_service_key");
    if (!agentedgeKey) {
      throw new HttpError(
        400,
        "Add your AgentEdge service role key in Settings → API keys first",
      );
    }

    // Fetch all crm_clients from AgentEdge in pages
    const allClients: CrmClient[] = [];
    let offset = 0;
    while (true) {
      const resp = await fetch(
        `${AGENTEDGE_URL}/rest/v1/crm_clients?select=*&order=id&limit=${PAGE_SIZE}&offset=${offset}`,
        {
          headers: {
            Authorization: `Bearer ${agentedgeKey}`,
            apikey: agentedgeKey,
            "Content-Type": "application/json",
          },
        },
      );
      if (!resp.ok) {
        const body = await resp.text();
        throw new HttpError(502, `AgentEdge API ${resp.status}: ${body.slice(0, 200)}`);
      }
      const page = await resp.json() as CrmClient[];
      allClients.push(...page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    const normalized = normalize(allClients);
    if (normalized.length === 0) {
      return json({ ok: true, total: 0, inserted: 0, updated: 0 });
    }

    // Batch in chunks of 200 to stay well within RPC payload limits
    const BATCH = 200;
    let totalInserted = 0;
    let totalUpdated = 0;
    for (let i = 0; i < normalized.length; i += BATCH) {
      const chunk = normalized.slice(i, i + BATCH);
      const { data, error } = await db.rpc("ingest_agentedge_contacts", {
        p_user_id: userId,
        p_contacts: chunk,
      });
      if (error) throw new Error(`batch ${i / BATCH}: ${error.message}`);
      const result = data as { inserted: number; updated: number; total: number };
      totalInserted += result.inserted;
      totalUpdated += result.updated;
    }

    return json({ ok: true, total: normalized.length, inserted: totalInserted, updated: totalUpdated });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
}
