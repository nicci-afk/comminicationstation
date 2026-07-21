// Household configuration (Google OAuth client, Pub/Sub topic, app URL,
// Resend key, pipeline models). Any authenticated allowlisted user may set
// these — this is a two-person household app and both users are trusted
// admins. Secrets go straight to Vault; only pointers land in app_config.

import {
  getConfig,
  handleOptions,
  HttpError,
  json,
  requireUser,
  serviceClient,
  setConfig,
} from "./_shared/util.ts";

const PLAIN_KEYS = new Set([
  "google_client_id",
  "pubsub_topic",
  "pubsub_audience",
  "app_url",
  "digest_from_email",
]);
const SECRET_KEYS: Record<string, string> = {
  google_client_secret: "google_client_secret_vault_id",
  resend_api_key: "resend_api_key_vault_id",
};

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  const db = serviceClient();
  try {
    await requireUser(req, db);

    if (req.method === "GET") {
      const status: Record<string, unknown> = {};
      for (const k of PLAIN_KEYS) {
        status[k] = ((await getConfig(db, k))?.value as string) ?? null;
      }
      for (const [k, vaultKey] of Object.entries(SECRET_KEYS)) {
        status[k] = Boolean((await getConfig(db, vaultKey))?.id);
      }
      status["pipeline_models"] = (await getConfig(db, "pipeline_models")) ?? null;
      status["worker_base_url"] = ((await getConfig(db, "worker_base_url"))?.url as string) ?? null;
      return json(status);
    }

    const body = await req.json();
    const key = String(body.key ?? "");
    const value = body.value;

    if (PLAIN_KEYS.has(key)) {
      await setConfig(db, key, { value: String(value ?? "").trim() });
      // Deriving the Pub/Sub audience automatically when app config lands:
      if (key === "google_client_id" && !(await getConfig(db, "pubsub_audience"))) {
        const base = ((await getConfig(db, "worker_base_url"))?.url as string) ?? "";
        if (base) await setConfig(db, "pubsub_audience", { value: `${base}/gmail-push` });
      }
      return json({ ok: true });
    }

    if (key in SECRET_KEYS) {
      const secret = String(value ?? "").trim();
      if (secret.length < 8) throw new HttpError(400, "value too short");
      const { data: id, error } = await db.rpc("vault_upsert_secret", {
        p_name: `app:${key}`,
        p_value: secret,
      });
      if (error) throw new Error(error.message);
      await setConfig(db, SECRET_KEYS[key], { id });
      return json({ ok: true });
    }

    if (key === "pipeline_models") {
      const v = value as Record<string, string>;
      await setConfig(db, "pipeline_models", {
        ...(v.stage1 ? { stage1: v.stage1 } : {}),
        ...(v.stage2 ? { stage2: v.stage2 } : {}),
        ...(v.stage3 ? { stage3: v.stage3 } : {}),
      });
      return json({ ok: true });
    }

    throw new HttpError(400, `unknown config key: ${key}`);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
}
