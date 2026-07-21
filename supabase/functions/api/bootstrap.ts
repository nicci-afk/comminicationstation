// One-time administrative bootstrap: allowlist emails and create the two
// household users (email pre-confirmed — no SMTP dependency). Protected by a
// machine secret generated at provision time and stored in Vault; not part of
// normal app operation.

import { getConfig, json, readVaultSecret, serviceClient } from "./_shared/util.ts";

export default async function handler(req: Request): Promise<Response> {
  const db = serviceClient();
  try {
    const presented = req.headers.get("x-bootstrap-secret") ?? "";
    const keyId = (await getConfig(db, "bootstrap_secret_vault_id"))?.id as string | undefined;
    if (!keyId) return json({ error: "bootstrap not configured" }, 500);
    const expected = await readVaultSecret(db, keyId);
    if (!expected || presented !== expected) return json({ error: "forbidden" }, 403);

    const body = await req.json();
    const action = body.action as string;

    if (action === "allow_email") {
      const { error } = await db.from("allowed_emails").upsert({
        email: String(body.email).toLowerCase(),
        note: String(body.note ?? ""),
      });
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }

    if (action === "create_user") {
      const { data, error } = await db.auth.admin.createUser({
        email: String(body.email).toLowerCase(),
        password: String(body.password),
        email_confirm: true,
        user_metadata: { display_name: String(body.display_name ?? "") },
      });
      if (error) throw new Error(error.message);
      return json({ ok: true, user_id: data.user?.id });
    }

    if (action === "delete_user") {
      const email = String(body.email).toLowerCase();
      const { data: profile } = await db.from("profiles").select("user_id").eq("email", email).maybeSingle();
      if (!profile) return json({ ok: true, note: "no such user" });
      const { error } = await db.auth.admin.deleteUser(profile.user_id);
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}
