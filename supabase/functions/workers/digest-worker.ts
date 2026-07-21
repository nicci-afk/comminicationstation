// Morning digest: one email per user per local day at their chosen hour,
// listing today's needs-attention queue. Enqueued by the hourly cron sweep.

import { getConfig, handleOptions, readVaultSecret, runWorker } from "./_shared/util.ts";

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  return await runWorker(req, "digest_jobs", 60, 100_000, async (db, job) => {
    const userId = job.message.user_id as string;
    const { data: profile } = await db
      .from("profiles")
      .select("user_id,email,display_name,timezone")
      .eq("user_id", userId)
      .maybeSingle();
    if (!profile) return;

    const today = new Date().toLocaleDateString("en-CA", { timeZone: profile.timezone });
    const { data: existing } = await db
      .from("digest_log")
      .select("sent_on")
      .eq("user_id", userId)
      .eq("sent_on", today)
      .maybeSingle();
    if (existing) return;

    const { data: items } = await db
      .from("queue_items")
      .select("title,sender_name,sender_identifier,category,priority,channel,is_vip,escalated")
      .eq("user_id", userId)
      .eq("state", "needs_attention")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(15);
    const { count: totalCount } = await db
      .from("queue_items")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("state", "needs_attention");
    const { count: awaitingCount } = await db
      .from("queue_items")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("state", "awaiting_reply");

    const keyId = (await getConfig(db, "resend_api_key_vault_id"))?.id as string | undefined;
    const fromEmail = ((await getConfig(db, "digest_from_email"))?.value as string) ??
      "Command Center <onboarding@resend.dev>";
    const appUrl = ((await getConfig(db, "app_url"))?.value as string) ?? "";

    if (!keyId) {
      await db.from("digest_log").insert({
        user_id: userId, sent_on: today, item_count: totalCount ?? 0,
        status: "skipped", error: "resend not configured",
      });
      return;
    }
    const apiKey = await readVaultSecret(db, keyId);

    const rows = (items ?? []).map((i) => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">
          ${i.is_vip ? "⭐ " : ""}${i.escalated ? "🔴 " : ""}<strong>${escapeHtml(i.sender_name || i.sender_identifier)}</strong><br/>
          <span style="color:#555">${escapeHtml(i.title || "(no subject)")}</span>
        </td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#777;font-size:12px;">${i.category}<br/>${i.channel}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${i.priority}</td>
      </tr>`).join("");

    const html = `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="margin-bottom:4px;">Good morning${profile.display_name ? ", " + escapeHtml(profile.display_name) : ""} 👋</h2>
        <p style="margin-top:0;color:#555;">
          <strong>${totalCount ?? 0}</strong> message${(totalCount ?? 0) === 1 ? "" : "s"} need${(totalCount ?? 0) === 1 ? "s" : ""} you today
          · ${awaitingCount ?? 0} awaiting their reply
        </p>
        ${(totalCount ?? 0) === 0
          ? `<p style="font-size:18px;">🎉 Queue is clear. Nothing needs you.</p>`
          : `<table style="width:100%;border-collapse:collapse;font-size:14px;">${rows}</table>`}
        ${appUrl ? `<p style="margin-top:16px;"><a href="${appUrl}/today" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;">Open Focus Mode</a></p>` : ""}
      </div>`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: fromEmail,
        to: [profile.email],
        subject: `☀️ ${totalCount ?? 0} need you today — Command Center`,
        html,
      }),
    });
    if (!res.ok) {
      await db.from("digest_log").insert({
        user_id: userId, sent_on: today, item_count: totalCount ?? 0,
        status: "error", error: (await res.text()).slice(0, 300),
      });
      return;
    }
    await db.from("digest_log").insert({
      user_id: userId, sent_on: today, item_count: totalCount ?? 0, status: "sent",
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
