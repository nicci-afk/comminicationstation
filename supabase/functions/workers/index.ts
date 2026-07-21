// Queue-drainer function: https://<project>.supabase.co/functions/v1/workers/<route>
// Split from the user-facing `api` function purely for deploy-bundle size.
// verify_jwt=false; every worker independently requires the Vault worker
// secret (requireWorkerAuth) before touching anything.

import gmailSyncWorker from "./gmail-sync-worker.ts";
import triageWorker from "./triage-worker.ts";
import pipelineWorker from "./pipeline-worker.ts";
import digestWorker from "./digest-worker.ts";
import { corsHeaders } from "./_shared/util.ts";

type Handler = (req: Request) => Promise<Response>;

const routes: Record<string, Handler> = {
  "gmail-sync-worker": gmailSyncWorker,
  "triage-worker": triageWorker,
  "pipeline-worker": pipelineWorker,
  "digest-worker": digestWorker,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  const segments = new URL(req.url).pathname.split("/").filter(Boolean);
  const route = segments[segments.indexOf("workers") + 1] ?? "";
  const handler = routes[route];
  if (!handler) {
    return new Response(JSON.stringify({ error: `unknown worker: ${route}` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    return await handler(req);
  } catch (e) {
    console.error(`worker ${route} crashed:`, e);
    return new Response(JSON.stringify({ error: "internal error" }), { status: 500 });
  }
});
