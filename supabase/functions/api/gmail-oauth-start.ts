// Begin the Google OAuth flow for connecting a Gmail account.
// Auth: user JWT (verify_jwt=true). Returns the consent URL to open.

import {
  getConfig,
  handleOptions,
  HttpError,
  json,
  requireUser,
  serviceClient,
  SUPABASE_URL,
} from "./_shared/util.ts";
import { googleClientConfig } from "./_shared/gmail.ts";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "openid",
  "email",
].join(" ");

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  const db = serviceClient();
  try {
    const { userId } = await requireUser(req, db);
    const cfg = await googleClientConfig(db);
    const appUrl = (await getConfig(db, "app_url"))?.value as string | undefined;

    const state = crypto.randomUUID();
    const { error } = await db.from("oauth_states").insert({
      state,
      user_id: userId,
      kind: "gmail",
      redirect_to: appUrl ? `${appUrl}/settings` : null,
    });
    if (error) throw new Error(error.message);

    const redirectUri = `${SUPABASE_URL}/functions/v1/api/gmail-oauth-callback`;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    return json({ url: url.toString() });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
}
