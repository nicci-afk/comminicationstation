// Phase 1: Cross-reference AgentEdge email_followups with Command Center threads.
// Phase 2: Auto-approve pending new_bdm / new_supplier / booking_candidates in AgentEdge.
// Triggered once by the user from Settings → Connections.

import {
  getUserSecret,
  handleOptions,
  HttpError,
  json,
  requireUser,
  serviceClient,
} from "./_shared/util.ts";

const AGENTEDGE_URL = "https://iitrvppynxisvhztbybw.supabase.co";
const AE_USER_ID = "367a5e0f-4438-44f6-b29d-88bfb134826c";

function aeHeaders(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    apikey: key,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

async function aeFetch(path: string, key: string): Promise<unknown[]> {
  const resp = await fetch(`${AGENTEDGE_URL}/rest/v1/${path}`, {
    headers: aeHeaders(key),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new HttpError(502, `AgentEdge ${resp.status}: ${t.slice(0, 200)}`);
  }
  return resp.json();
}

async function aePatch(path: string, key: string, body: unknown): Promise<unknown> {
  const resp = await fetch(`${AGENTEDGE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: aeHeaders(key),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`AgentEdge PATCH ${path} ${resp.status}: ${t.slice(0, 200)}`);
  }
  return resp.json();
}

async function aePost(path: string, key: string, body: unknown): Promise<Record<string, unknown>> {
  const resp = await fetch(`${AGENTEDGE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: aeHeaders(key),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`AgentEdge POST ${path} ${resp.status}: ${t.slice(0, 200)}`);
  }
  const result = await resp.json();
  return Array.isArray(result) ? result[0] : result;
}

function tripType(t: string | null | undefined): "flight" | "hotel" | "package" {
  const v = (t ?? "").toLowerCase();
  if (v.includes("flight") || v.includes("air")) return "flight";
  if (v.includes("hotel") || v.includes("resort")) return "hotel";
  return "package";
}

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  const db = serviceClient();
  try {
    const { userId } = await requireUser(req, db);

    const aeKey = await getUserSecret(db, userId, "agentedge_service_key");
    if (!aeKey) {
      throw new HttpError(400, "Add your AgentEdge service role key in Settings → API keys first");
    }

    // ── Phase 1: email_followups reconciliation ────────────────────────────

    const followups = (await aeFetch(
      `email_followups?select=id,kind,status,counterparty_name,counterparty_email,title,summary,priority,source_ref,occurred_at&order=occurred_at.desc&limit=500`,
      aeKey,
    )) as Array<Record<string, unknown>>;

    let synced = 0;
    let gaps = 0;
    let alreadyResolved = 0;

    const openNeedsResponse = followups.filter(
      (f) => f.kind === "needs_response" && f.status === "open",
    );

    for (const f of openNeedsResponse) {
      const sourceRef = (f.source_ref ?? {}) as Record<string, unknown>;
      const gmailThreadId = sourceRef.gmail_thread_id as string | undefined;

      if (!gmailThreadId) {
        // iMessage or other non-Gmail source — log as gap, skip
        await db.from("agentedge_sync_log").insert({
          user_id: userId,
          direction: "gap",
          ae_table: "email_followups",
          ae_id: String(f.id),
          status: "no_thread_id",
          notes: `${f.counterparty_name || ""} — non-Gmail source`,
        });
        gaps++;
        continue;
      }

      // Look up this thread in Command Center across all gmail accounts for this user
      const { data: thread } = await db
        .from("threads")
        .select("id")
        .eq("user_id", userId)
        .eq("provider_thread_id", gmailThreadId)
        .maybeSingle();

      if (!thread) {
        // Thread not yet in Command Center — log as gap for natural catch-up
        await db.from("agentedge_sync_log").insert({
          user_id: userId,
          direction: "gap",
          ae_table: "email_followups",
          ae_id: String(f.id),
          status: "not_in_cc",
          notes: `${f.counterparty_name || f.counterparty_email || gmailThreadId} — thread not synced yet`,
        });
        gaps++;
        continue;
      }

      // Thread exists — check queue item state
      const { data: qi } = await db
        .from("queue_items")
        .select("id,state")
        .eq("thread_id", thread.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!qi || ["responded", "dismissed"].includes(qi.state)) {
        // Already resolved in Command Center
        await db.from("agentedge_sync_log").insert({
          user_id: userId,
          direction: "imported",
          ae_table: "email_followups",
          ae_id: String(f.id),
          cc_queue_item_id: qi?.id ?? null,
          status: "already_resolved",
        });
        alreadyResolved++;
      } else {
        // Open in both systems — properly synced
        await db.from("agentedge_sync_log").insert({
          user_id: userId,
          direction: "imported",
          ae_table: "email_followups",
          ae_id: String(f.id),
          cc_queue_item_id: qi.id,
          status: "synced",
        });
        synced++;
      }
    }

    // ── Phase 2a: auto-approve pending BDM / supplier followups ──────────

    const pendingBdms = followups.filter(
      (f) => f.kind === "new_bdm" && f.status === "open",
    );
    const pendingSuppliers = followups.filter(
      (f) => f.kind === "new_supplier" && f.status === "open",
    );

    let bdmsApproved = 0;
    for (const f of [...pendingBdms, ...pendingSuppliers]) {
      try {
        await aePatch(
          `email_followups?id=eq.${f.id}`,
          aeKey,
          { status: "approved" },
        );
        await db.from("agentedge_sync_log").insert({
          user_id: userId,
          direction: "approved",
          ae_table: "email_followups",
          ae_id: String(f.id),
          category: f.kind === "new_bdm" ? "bdm" : "possible_supplier",
          status: "ok",
          notes: String(f.counterparty_name || f.counterparty_email || ""),
        });
        bdmsApproved++;
      } catch (e) {
        console.error("BDM approve failed:", e);
      }
    }

    // ── Phase 2b: auto-approve pending booking_candidates ─────────────────

    const candidates = (await aeFetch(
      `booking_candidates?select=id,status,confidence,travel_type,supplier_name,confirmation_number,traveler_names,start_date,end_date,origin,destination,total_amount,currency,summary&status=eq.pending&order=detected_at.desc`,
      aeKey,
    )) as Array<Record<string, unknown>>;

    let bookingsCreated = 0;
    for (const c of candidates) {
      try {
        const booking = await aePost("bookings", aeKey, {
          user_id: AE_USER_ID,
          client_name: String(c.traveler_names || "Unknown"),
          destination: String(c.destination || "Unknown"),
          trip_type: tripType(c.travel_type as string),
          original_price: Number(c.total_amount ?? 0),
          current_price: Number(c.total_amount ?? 0),
          departure_date:
            (c.start_date as string) || new Date().toISOString().slice(0, 10),
          return_date: (c.end_date as string) || null,
          booking_reference: (c.confirmation_number as string) || null,
          supplier: (c.supplier_name as string) || null,
          status: "booked",
          has_price_drop: false,
          price_watch_paused: false,
          commission_collected: false,
          contractor_payout_paid: false,
        });

        // Mark the candidate as added
        await aePatch(
          `booking_candidates?id=eq.${c.id}`,
          aeKey,
          {
            status: "added",
            created_booking_id: booking.id,
            resolved_at: new Date().toISOString(),
          },
        );

        await db.from("agentedge_sync_log").insert({
          user_id: userId,
          direction: "approved",
          ae_table: "bookings",
          ae_id: String(booking.id),
          category: "booking",
          status: "ok",
          notes: `${c.traveler_names || ""} → ${c.destination || ""}`,
        });
        bookingsCreated++;
      } catch (e) {
        console.error("Booking candidate approve failed:", e);
        await db.from("agentedge_sync_log").insert({
          user_id: userId,
          direction: "approved",
          ae_table: "booking_candidates",
          ae_id: String(c.id),
          category: "booking",
          status: "error",
          notes: (e as Error).message.slice(0, 300),
        }).catch(() => {});
      }
    }

    return json({
      ok: true,
      phase1: {
        open_needs_response: openNeedsResponse.length,
        synced,
        already_resolved: alreadyResolved,
        gaps,
      },
      phase2: {
        bdms_and_suppliers_approved: bdmsApproved,
        bookings_created: bookingsCreated,
        booking_candidates_processed: candidates.length,
      },
    });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
}
