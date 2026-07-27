// POST {} — merges contacts from the user's AgentEdge CRM into the command center.
// Requires 'agentedge_service_key' stored via Settings → API keys.
// Uses ingest_agentedge_contacts RPC (service-role only) for batch merge.

import { getUserSecret, handleOptions, HttpError, json, requireUser, serviceClient } from "./_shared/util.ts";

const AGENTEDGE_URL = "https://iitrvppynxisvhztbybw.supabase.co";
const PAGE_SIZE = 500;

interface CrmClient {
  display_name: string | null;
  email: string | null;
  alt_emails: string[] | null;
  phone: string | null;
  alt_phones: string[] | null;
  date_of_birth: string | null;
  notes: string | null;
}

interface NormalizedContact {
  display_name: string;
  birthday: string | null;
  notes: string;
  emails: string[];
  phones: string[];
}

function normalize(clients: CrmClient[]): NormalizedContact[] {
  return clients
    .filter((c) => {
      const name = (c.display_name ?? "").trim();
      return name.length > 0 && !/^[\d\s+\-().]+$/.test(name);
    })
    .map((c) => {
      const emails = [
        ...(c.email ? [c.email.toLowerCase().trim()] : []),
        ...(c.alt_emails ?? []).map((e) => e.toLowerCase().trim()),
      ].filter((e) => e.includes("@"));
      const phones = [
        ...(c.phone ? [c.phone.trim()] : []),
        ...(c.alt_phones ?? []).map((p) => p.trim()),
      ].filter(Boolean);
      return {
        display_name: (c.display_name ?? "").trim(),
        birthday: c.date_of_birth ?? null,
        notes: c.notes ?? "",
        emails: [...new Set(emails)],
        phones: [...new Set(phones)],
      };
    });
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
        `${AGENTEDGE_URL}/rest/v1/crm_clients?select=display_name,email,alt_emails,phone,alt_phones,date_of_birth,notes&order=id&limit=${PAGE_SIZE}&offset=${offset}`,
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
      const page: CrmClient[] = await resp.json();
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
