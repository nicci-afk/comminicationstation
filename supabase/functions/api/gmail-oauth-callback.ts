// Google redirects here after consent. Auth: none at the platform level
// (verify_jwt=false) — the OAuth `state` nonce (server-stored, single-use,
// bound to the initiating user) is the authentication. This is the CSRF gate
// that prevents account-linking attacks.

import { enqueue, getConfig, serviceClient } from "./_shared/util.ts";
import { exchangeCode, googleClientConfig } from "./_shared/gmail.ts";

function decodeJwtPayload(idToken: string): Record<string, unknown> {
  const payload = idToken.split(".")[1];
  const pad = payload.length % 4 === 0 ? "" : "=".repeat(4 - (payload.length % 4));
  const b64 = payload.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
}

function redirectResponse(to: string, params: Record<string, string>): Response {
  const url = new URL(to);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

export default async function handler(req: Request): Promise<Response> {
  const db = serviceClient();
  const u = new URL(req.url);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  const appUrl = ((await getConfig(db, "app_url"))?.value as string) ?? "";
  const fallback = appUrl ? `${appUrl}/settings` : "https://example.invalid";

  try {
    if (!code || !state) throw new Error("missing code/state");

    // Burn the nonce: single use, unexpired, and it names the tenant.
    const { data: st } = await db
      .from("oauth_states")
      .delete()
      .eq("state", state)
      .gt("expires_at", new Date().toISOString())
      .select()
      .maybeSingle();
    if (!st) throw new Error("invalid or expired state");
    const userId = st.user_id as string;
    const redirectTo = (st.redirect_to as string) || fallback;

    const cfg = await googleClientConfig(db);
    const redirectUri = `${new URL(req.url).origin}/functions/v1/api/gmail-oauth-callback`;
    const tokens = await exchangeCode(cfg, code, redirectUri);

    const idToken = (tokens as Record<string, unknown>)["id_token"] as string | undefined;
    if (!idToken) throw new Error("no id_token in token response");
    const claims = decodeJwtPayload(idToken);
    const email = String(claims["email"] ?? "").toLowerCase();
    if (!email || claims["email_verified"] !== true) {
      throw new Error("could not verify Gmail address");
    }

    // The unique constraint on email_address enforces one-tenant-per-mailbox;
    // an attempt to link a mailbox owned by the other user fails here.
    const { data: existing } = await db
      .from("gmail_accounts")
      .select("id,user_id,refresh_token_secret_id")
      .eq("email_address", email)
      .maybeSingle();
    if (existing && existing.user_id !== userId) {
      throw new Error(`${email} is already connected to another account`);
    }

    let accountId: string;
    if (existing) {
      accountId = existing.id as string;
    } else {
      const { data: created, error } = await db
        .from("gmail_accounts")
        .insert({ user_id: userId, email_address: email, status: "pending" })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      accountId = created.id as string;
    }

    if (tokens.refresh_token) {
      const { data: secretId, error: vErr } = await db.rpc("vault_upsert_secret", {
        p_name: `gmail_refresh:${accountId}`,
        p_value: tokens.refresh_token,
      });
      if (vErr) throw new Error(vErr.message);
      await db
        .from("gmail_accounts")
        .update({ refresh_token_secret_id: secretId, status: "active", last_error: null })
        .eq("id", accountId);
    } else if (!existing?.refresh_token_secret_id) {
      throw new Error("Google did not return a refresh token — remove the app at myaccount.google.com/permissions and reconnect");
    } else {
      await db.from("gmail_accounts").update({ status: "active", last_error: null }).eq("id", accountId);
    }

    // Watch first (no gap), then backfill.
    await enqueue(db, "sync_jobs", { kind: "renew_watch", gmail_account_id: accountId });
    await enqueue(db, "sync_jobs", { kind: "backfill", gmail_account_id: accountId, phase: "recent" });

    return redirectResponse(redirectTo, { gmail: "connected", email });
  } catch (e) {
    console.error("oauth callback failed:", e);
    return redirectResponse(fallback, { gmail: "error", message: (e as Error).message.slice(0, 200) });
  }
}
