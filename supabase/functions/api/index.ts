// Single routed entry point for all backend endpoints:
//   https://<project>.supabase.co/functions/v1/api/<route>
// Deployed with verify_jwt=false; every route enforces its own auth in code:
//   - user endpoints: JWT resolved via auth.getUser (requireUser)
//   - workers: shared worker secret from Vault (requireWorkerAuth)
//   - webhooks: Pub/Sub OIDC verification / Twilio signature / OAuth state
//   - bootstrap: one-time machine secret

import gmailOauthStart from "./gmail-oauth-start.ts";
import gmailOauthCallback from "./gmail-oauth-callback.ts";
import gmailPush from "./gmail-push.ts";
import gmailSyncWorker from "./gmail-sync-worker.ts";
import gmailGetBody from "./gmail-get-body.ts";
import triageWorker from "./triage-worker.ts";
import pipelineStart from "./pipeline-start.ts";
import pipelineWorker from "./pipeline-worker.ts";
import draftReply from "./draft-reply.ts";
import interactionUpdate from "./interaction-update.ts";
import twilioInbound from "./twilio-inbound.ts";
import twilioSend from "./twilio-send.ts";
import twilioProvision from "./twilio-provision.ts";
import adminConfig from "./admin-config.ts";
import digestWorker from "./digest-worker.ts";
import bootstrap from "./bootstrap.ts";
import { corsHeaders } from "./_shared/util.ts";

type Handler = (req: Request) => Promise<Response>;

const routes: Record<string, Handler> = {
  "gmail-oauth-start": gmailOauthStart,
  "gmail-oauth-callback": gmailOauthCallback,
  "gmail-push": gmailPush,
  "gmail-sync-worker": gmailSyncWorker,
  "gmail-get-body": gmailGetBody,
  "triage-worker": triageWorker,
  "pipeline-start": pipelineStart,
  "pipeline-worker": pipelineWorker,
  "draft-reply": draftReply,
  "interaction-update": interactionUpdate,
  "twilio-inbound": twilioInbound,
  "twilio-send": twilioSend,
  "twilio-provision": twilioProvision,
  "admin-config": adminConfig,
  "digest-worker": digestWorker,
  "bootstrap": bootstrap,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  const path = new URL(req.url).pathname;
  const segments = path.split("/").filter(Boolean);
  const route = segments[segments.indexOf("api") + 1] ?? "";
  const handler = routes[route];
  if (!handler) {
    return new Response(JSON.stringify({ error: `unknown route: ${route}` }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
  try {
    return await handler(req);
  } catch (e) {
    console.error(`route ${route} crashed:`, e);
    return new Response(JSON.stringify({ error: "internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
});
