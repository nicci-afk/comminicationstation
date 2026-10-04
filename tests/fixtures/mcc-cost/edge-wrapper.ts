// LOCAL VALIDATION ONLY. Exact unmodified workers bundle is under bundle/.
const nativeFetch = globalThis.fetch.bind(globalThis);
const nativeServe = Deno.serve.bind(Deno);
const local = new URL(Deno.env.get("SUPABASE_URL")!);
if (local.protocol !== "http:" || !/^(kong|localhost|127\.0\.0\.1|supabase_kong_[a-z0-9_-]+)$/.test(local.hostname)) {
  throw new Error("Cost fixture refuses nonlocal database");
}
const secret = Deno.env.get("WORKER_SECRET");
if (!secret?.startsWith("mcc-local-fixture-")) throw new Error("Synthetic worker secret required");
let events: Record<string, unknown>[] = [];
let mode = "success";
let active = false;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
globalThis.fetch = async (input: Request | URL | string, init?: RequestInit) => {
  const req = new Request(input, init), url = new URL(req.url);
  if (url.origin === local.origin) {
    events.push({ kind: "local", path: url.pathname, method: req.method });
    return await nativeFetch(new Request(req, { redirect: "error" }));
  }
  if (active && url.href === "https://api.anthropic.com/v1/messages" && req.method === "POST" &&
      req.headers.get("x-api-key") === "mcc-synthetic-anthropic-key") {
    const body = await req.json();
    if (body.max_tokens !== 400 || body.service_tier !== "standard_only" || body.tools || body.thinking || body.cache_control ||
        !/^claude-haiku-4-5-[0-9]{8}$/.test(body.model)) throw new Error("Unexpected paid request shape");
    events.push({ kind: "synthetic_model", model: body.model, max_tokens: body.max_tokens });
    if (mode === "error") return json({ type: "error", error: { type: "overloaded_error", message: "Synthetic error" } }, 500);
    const decision = { business_id: null, category: "booking", needs_reply: true, contact_kind: "human", priority: 30, reason: "Synthetic triage" };
    return json({ id: "fixture-only", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: mode === "malformed" ? "not JSON" : JSON.stringify(decision) }],
      usage: { input_tokens: 100, output_tokens: 20, service_tier: "standard", cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
  }
  events.push({ kind: "blocked_egress", origin: url.origin, path: url.pathname });
  throw new Error("Cost fixture blocks all nonlocal, nonsynthetic requests");
};
for (const key of ["connect", "connectTls", "createHttpClient", "resolveDns"]) {
  if (key in Deno) Object.defineProperty(Deno, key, { configurable: true, value: () => { throw new Error(`Blocked Deno.${key}`); } });
}
if ("WebSocket" in globalThis) Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class {
  constructor() { throw new Error("Cost fixture blocks WebSocket"); }
} });
let application: ((req: Request) => Promise<Response> | Response) | undefined;
Object.defineProperty(Deno, "serve", { configurable: true, value: (handler: typeof application) => { application = handler; return {}; } });
await import("./bundle/index.ts");
if (!application) throw new Error("Exact workers router did not register");
let pending = Promise.resolve();
nativeServe(async request => {
  const previous = pending; let release!: () => void;
  pending = new Promise<void>(resolve => { release = resolve; }); await previous;
  try {
    events = []; mode = "success";
    const url = new URL(request.url);
    if (!url.pathname.endsWith("/__runtime_boot") && !url.pathname.endsWith("/triage-worker")) throw new Error("Unexpected fixture route");
    if (request.method === "POST" && request.headers.get("x-worker-secret") === secret) {
      const body = await request.clone().json(); mode = body.mode ?? "success";
      if (!["success", "error", "malformed"].includes(mode)) throw new Error("Unknown fixture scenario");
    }
    active = true;
    url.pathname = url.pathname.replace("/cost-runtime/", "/workers/");
    const response = await application!(new Request(url, request));
    return new Response(JSON.stringify({ application: await response.json(), events, runtime: Deno.version }), {
      status: response.status, headers: { "content-type": "application/json", "x-mcc-cost-runtime": "1" },
    });
  } finally { active = false; release(); }
});
