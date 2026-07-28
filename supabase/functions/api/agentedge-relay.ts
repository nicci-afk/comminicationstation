// Worker: push newly-triaged MCC items to AgentEdge so booking detection,
// BDM tracking, and supplier promotions keep working without AgentEdge
// pulling email itself. Called by pg_cron every 15 minutes.
// Auth: x-worker-secret header (same pattern as other workers).

import {
  getUserSecret,
  handleOptions,
  json,
  requireWorkerAuth,
  serviceClient,
} from "./_shared/util.ts";

const AGENTEDGE_URL = "https://iitrvppynxisvhztbybw.supabase.co";
const AE_USER_ID = "367a5e0f-4438-44f6-b29d-88bfb134826c";
const MCC_USER_ID = "0c6cabc6-72cc-4a2b-98bb-13fbc4991129";

// Categories that warrant forwarding to AgentEdge
const RELAY_CATEGORIES = ["booking", "bdm", "possible_supplier", "promotion"];

function aeHeaders(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    apikey: key,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };
}

async function aePost(path: string, key: string, body: unknown): Promise<void> {
  const resp = await fetch(`${AGENTEDGE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: aeHeaders(key),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`AgentEdge POST ${path} ${resp.status}: ${t.slice(0, 200)}`);
  }
}

interface QueueItem {
  id: string;
  category: string;
  sender_name: string | null;
  sender_identifier: string | null;
  title: string | null;
  preview: string | null;
  priority: number | null;
  created_at: string;
  thread_id: string | null;
}

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  const db = serviceClient();

  await requireWorkerAuth(req, db);

  const aeKey = await getUserSecret(db, MCC_USER_ID, "agentedge_service_key");
  if (!aeKey) {
    return json({ ok: false, error: "AgentEdge service key not configured" }, 500);
  }

  // Fetch unrelayed items with relay-worthy categories (exclude backlog and very old items)
  const { data: items, error } = await db
    .from("queue_items")
    .select("id,category,sender_name,sender_identifier,title,preview,priority,created_at,thread_id")
    .in("category", RELAY_CATEGORIES)
    .is("agentedge_relayed_at", null)
    .neq("state", "backlog")
    .gte("created_at", new Date(Date.now() - 90 * 86400 * 1000).toISOString())
    .order("created_at", { ascending: true })
    .limit(100) as { data: QueueItem[] | null; error: unknown };

  if (error) return json({ ok: false, error: String(error) }, 500);
  if (!items || items.length === 0) return json({ ok: true, relayed: 0 });

  const results = { booking: 0, bdm: 0, supplier: 0, promotion: 0, errors: 0 };
  const relayedIds: string[] = [];

  for (const item of items) {
    const sourceRef = {
      mcc_queue_item_id: item.id,
      ...(item.thread_id ? { mcc_thread_id: item.thread_id } : {}),
    };

    try {
      if (item.category === "booking") {
        await aePost("booking_candidates", aeKey, {
          user_id: AE_USER_ID,
          status: "pending",
          supplier_name: item.sender_name ?? item.sender_identifier,
          summary: [item.title, item.preview].filter(Boolean).join(" — "),
          confidence: "low",
          source_ref: sourceRef,
          occurred_at: item.created_at,
        });
        results.booking++;
      } else if (item.category === "bdm") {
        await aePost("email_followups", aeKey, {
          user_id: AE_USER_ID,
          kind: "new_bdm",
          title: item.title ?? "New BDM",
          summary: item.preview ?? "",
          counterparty_name: item.sender_name ?? "",
          counterparty_email: item.sender_identifier ?? "",
          priority: (item.priority ?? 0) >= 60 ? "high" : "normal",
          status: "open",
          source_ref: sourceRef,
          occurred_at: item.created_at,
        });
        results.bdm++;
      } else if (item.category === "possible_supplier") {
        await aePost("email_followups", aeKey, {
          user_id: AE_USER_ID,
          kind: "new_supplier",
          title: item.title ?? "Possible supplier",
          summary: item.preview ?? "",
          counterparty_name: item.sender_name ?? "",
          counterparty_email: item.sender_identifier ?? "",
          priority: "normal",
          status: "open",
          source_ref: sourceRef,
          occurred_at: item.created_at,
        });
        results.supplier++;
      } else if (item.category === "promotion") {
        await aePost("supplier_promotions", aeKey, {
          user_id: AE_USER_ID,
          title: item.title ?? "Supplier promotion",
          summary: item.preview ?? "",
          promo_type: "promotion",
          status: "active",
          confidence: "low",
          source: "mcc_relay",
          source_ref: sourceRef,
          occurred_at: item.created_at,
        });
        results.promotion++;
      }

      relayedIds.push(item.id);
    } catch (e) {
      console.error(`relay failed for ${item.id}:`, e);
      results.errors++;
    }
  }

  // Mark successfully relayed items
  if (relayedIds.length > 0) {
    await db
      .from("queue_items")
      .update({ agentedge_relayed_at: new Date().toISOString() })
      .in("id", relayedIds);
  }

  return json({ ok: true, ...results, relayed: relayedIds.length });
}
