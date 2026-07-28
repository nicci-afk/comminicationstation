// Auto-push to AgentEdge after a queue item is categorised as booking / bdm /
// possible_supplier / promotion.  Called directly from the triage worker.
// Reads the AgentEdge service key and Anthropic key from Vault; silently skips
// if either is absent.

import { SupabaseClient } from "@supabase/supabase-js";
import { getUserSecret } from "./util.ts";
import { callAnthropic } from "./llm.ts";

const AGENTEDGE_URL = "https://iitrvppynxisvhztbybw.supabase.co";
const AE_USER_ID = "367a5e0f-4438-44f6-b29d-88bfb134826c";
const EXTRACT_MODEL = "claude-haiku-4-5";

export const PUSH_CATEGORIES = new Set([
  "booking", "bdm", "possible_supplier", "promotion",
]);

export async function maybePushToAgentedge(
  db: SupabaseClient,
  userId: string,
  messageId: string,
  category: string,
): Promise<void> {
  if (!PUSH_CATEGORIES.has(category)) return;

  const [aeKey, anthropicKey] = await Promise.all([
    getUserSecret(db, userId, "agentedge_service_key"),
    getUserSecret(db, userId, "anthropic_api_key"),
  ]);
  if (!aeKey || !anthropicKey) return;

  const { data: msg } = await db
    .from("messages")
    .select("id,subject,snippet,body_text,from_name,from_identifier,sent_at,thread_id")
    .eq("id", messageId)
    .maybeSingle();
  if (!msg) return;

  const { data: qi } = await db
    .from("queue_items")
    .select("id")
    .eq("thread_id", msg.thread_id)
    .in("state", ["needs_attention", "new", "fyi", "backlog"])
    .maybeSingle();

  const content = (msg.body_text || msg.snippet || "").slice(0, 2000);
  const from = `${msg.from_name || ""} <${msg.from_identifier || ""}>`.trim();
  const aeTable = tableFor(category);

  try {
    if (category === "booking") {
      await pushBooking(aeKey, anthropicKey, msg, from, content);
    } else if (category === "bdm") {
      await pushBdm(aeKey, anthropicKey, msg, from, content);
    } else if (category === "possible_supplier") {
      await pushSupplier(aeKey, msg);
    } else if (category === "promotion") {
      await pushPromotion(aeKey, anthropicKey, msg, from, content);
    }

    // Stamp the queue item so the relay cron skips it (no double-push)
    if (qi?.id) {
      await db.from("queue_items").update({ agentedge_relayed_at: new Date().toISOString() }).eq("id", qi.id);
    }

    await db.from("agentedge_sync_log").insert({
      user_id: userId,
      direction: "pushed",
      ae_table: aeTable,
      cc_queue_item_id: qi?.id ?? null,
      category,
      status: "ok",
    });
  } catch (e) {
    console.error("agentedge-push error:", e);
    await db.from("agentedge_sync_log").insert({
      user_id: userId,
      direction: "pushed",
      ae_table: aeTable,
      cc_queue_item_id: qi?.id ?? null,
      category,
      status: "error",
      notes: (e as Error).message.slice(0, 500),
    }).catch(() => {});
  }
}

function tableFor(category: string): string {
  const map: Record<string, string> = {
    booking: "bookings",
    bdm: "supplier_contacts",
    possible_supplier: "email_followups",
    promotion: "supplier_promotions",
  };
  return map[category] ?? "unknown";
}

async function aePost(path: string, key: string, body: unknown): Promise<Record<string, unknown>> {
  const resp = await fetch(`${AGENTEDGE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`AgentEdge POST ${path} ${resp.status}: ${t.slice(0, 200)}`);
  }
  const result = await resp.json();
  return Array.isArray(result) ? result[0] : result;
}

async function extract(key: string, system: string, user: string): Promise<Record<string, unknown>> {
  const result = await callAnthropic({
    apiKey: key,
    model: EXTRACT_MODEL,
    system,
    maxTokens: 400,
    user,
  });
  return (result.parsed as Record<string, unknown>) ?? {};
}

function tripType(t: string | null | undefined): "flight" | "hotel" | "package" {
  const v = (t ?? "").toLowerCase();
  if (v.includes("flight") || v.includes("air")) return "flight";
  if (v.includes("hotel") || v.includes("resort")) return "hotel";
  return "package";
}

async function pushBooking(
  aeKey: string,
  anthropicKey: string,
  msg: Record<string, unknown>,
  from: string,
  content: string,
): Promise<void> {
  const extracted = await extract(
    anthropicKey,
    `Extract booking info as JSON with keys: supplier_name, confirmation_number,
traveler_names, travel_type (flight|hotel|package), start_date (YYYY-MM-DD|null),
end_date (YYYY-MM-DD|null), destination (string), total_amount (number|null).
ONLY valid JSON, no markdown.`,
    `From: ${from}\nSubject: ${msg.subject}\n\n${content}`,
  );

  await aePost("bookings", aeKey, {
    user_id: AE_USER_ID,
    client_name: String(extracted.traveler_names || "Unknown"),
    destination: String(extracted.destination || "Unknown"),
    trip_type: tripType(extracted.travel_type as string),
    original_price: Number(extracted.total_amount ?? 0),
    current_price: Number(extracted.total_amount ?? 0),
    departure_date:
      extracted.start_date || new Date().toISOString().slice(0, 10),
    return_date: extracted.end_date || null,
    booking_reference: extracted.confirmation_number || null,
    supplier: extracted.supplier_name || null,
    status: "booked",
    has_price_drop: false,
    price_watch_paused: false,
    commission_collected: false,
    contractor_payout_paid: false,
  });
}

async function pushBdm(
  aeKey: string,
  anthropicKey: string,
  msg: Record<string, unknown>,
  from: string,
  content: string,
): Promise<void> {
  const extracted = await extract(
    anthropicKey,
    `Extract BDM contact info as JSON: full_name, email, phone (|null),
role (e.g. "BDM"), supplier_name. ONLY valid JSON.`,
    `From: ${from}\nSubject: ${msg.subject}\n\n${content.slice(0, 1000)}`,
  );

  await aePost("supplier_contacts", aeKey, {
    user_id: AE_USER_ID,
    full_name: String(extracted.full_name || msg.from_name || "Unknown"),
    email: String(extracted.email || msg.from_identifier || ""),
    phone: extracted.phone || null,
    role: String(extracted.role || "BDM"),
    status: "active",
    source: "email",
    source_ref: { gmail_message_id: msg.id, auto_pushed: true },
    first_seen_at: msg.sent_at || new Date().toISOString(),
  });
}

async function pushSupplier(
  aeKey: string,
  msg: Record<string, unknown>,
): Promise<void> {
  await aePost("email_followups", aeKey, {
    user_id: AE_USER_ID,
    kind: "new_supplier",
    title: String(msg.subject || "New Supplier Contact").slice(0, 200),
    counterparty_name: String(msg.from_name || ""),
    counterparty_email: String(msg.from_identifier || ""),
    priority: "normal",
    status: "approved",
    source_ref: { gmail_message_id: msg.id, auto_pushed: true },
    occurred_at: msg.sent_at || new Date().toISOString(),
  });
}

async function pushPromotion(
  aeKey: string,
  anthropicKey: string,
  msg: Record<string, unknown>,
  from: string,
  content: string,
): Promise<void> {
  const extracted = await extract(
    anthropicKey,
    `Extract travel promotion info as JSON: title (≤120 chars), summary (≤300 chars),
promo_type (string), offer_value (string), destinations (string[]),
booking_window_start (YYYY-MM-DD|null), booking_window_end (YYYY-MM-DD|null),
travel_window_start (YYYY-MM-DD|null), travel_window_end (YYYY-MM-DD|null),
valid_through (YYYY-MM-DD|null). ONLY valid JSON.`,
    `From: ${from}\nSubject: ${msg.subject}\n\n${content}`,
  );

  await aePost("supplier_promotions", aeKey, {
    user_id: AE_USER_ID,
    title: String(extracted.title || msg.subject || "Promotion").slice(0, 120),
    summary: String(extracted.summary || "").slice(0, 300),
    promo_type: extracted.promo_type || null,
    offer_value: extracted.offer_value || null,
    destinations: Array.isArray(extracted.destinations) ? extracted.destinations : [],
    booking_window_start: extracted.booking_window_start || null,
    booking_window_end: extracted.booking_window_end || null,
    travel_window_start: extracted.travel_window_start || null,
    travel_window_end: extracted.travel_window_end || null,
    valid_through: extracted.valid_through || null,
    status: "active",
    confidence: "high",
    source: "email",
    source_ref: { gmail_message_id: msg.id, auto_pushed: true },
    content_hash: String(msg.id).slice(0, 32),
    occurred_at: msg.sent_at || new Date().toISOString(),
  });
}
