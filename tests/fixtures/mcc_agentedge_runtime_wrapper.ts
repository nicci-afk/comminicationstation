// TEST-ONLY entrypoint. Never deploy this wrapper. The imported bundle is copied
// byte-for-byte; all runtime I/O is local or synthetic before it is imported.
const nativeFetch = globalThis.fetch.bind(globalThis);
const nativeServe = Deno.serve.bind(Deno);
const local = new URL(Deno.env.get("SUPABASE_URL")!);
if (local.protocol !== "http:" || !/^(kong|localhost|127\.0\.0\.1|supabase_kong_[a-z0-9_-]+)$/.test(local.hostname)) {
  throw new Error("Runtime fixture refuses a non-local Supabase URL");
}
const testSecret = Deno.env.get("WORKER_SECRET");
if (!testSecret?.startsWith("mcc-local-fixture-")) throw new Error("Local test secret missing");
let events: Record<string, unknown>[] = [];
const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});
globalThis.fetch = async (input: Request | URL | string, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin === local.origin) {
    let kind: string | undefined;
    if (url.pathname === "/rest/v1/rpc/get_user_secret") {
      kind = (await request.clone().json()).p_kind;
    }
    events.push({ kind: "local_fetch", path: url.pathname, query: url.search, method: request.method, secretKind: kind });
    // Manual redirect handling prevents a local response redirecting real I/O.
    return nativeFetch(new Request(request, { redirect: "error" }));
  }
  if (url.href === "https://api.anthropic.com/v1/messages" && request.method === "POST") {
    const body = await request.json();
    const triage = body.model === "claude-haiku-4-5" &&
      typeof body.messages?.[0]?.content === "string" &&
      body.messages[0].content.includes('"subject":"LOCAL RUNTIME TRIAGE FIXTURE"');
    events.push({ kind: triage ? "synthetic_triage" : "blocked_extraction", model: body.model });
    if (!triage) throw new Error("Runtime fixture blocks extraction/model egress");
    return respond({ id: "msg_local_fixture", type: "message", role: "assistant", model: body.model,
      content: [{ type: "text", text: JSON.stringify({ category: "booking", priority: 70, needs_reply: true, reason: "local fixture" }) }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });
  }
  events.push({ kind: "blocked_egress", origin: url.origin, path: url.pathname });
  throw new Error("Runtime fixture blocks non-local egress");
};
// Any accidental alternate network API also fails closed. Dependency loading is
// handled by the runtime loader, before module execution, not by these APIs.
for (const key of ["connect", "connectTls", "createHttpClient", "resolveDns"]) {
  if (key in Deno) Object.defineProperty(Deno, key, { value: () => { throw new Error(`Fixture blocks Deno.${key}`); }, configurable: true });
}
if ("WebSocket" in globalThis) Object.defineProperty(globalThis, "WebSocket", { value: class { constructor() { throw new Error("Fixture blocks WebSocket"); } }, configurable: true });
const originalInfo = console.info.bind(console);
console.info = (...args) => {
  for (const arg of args) {
    if (typeof arg === "string") {
      try { const value = JSON.parse(arg); if (value.event === "agentedge_write_paused") events.push({ kind: "pause_log", ...value }); } catch { /* ordinary log */ }
    }
  }
  originalInfo(...args);
};
let application: ((request: Request) => Promise<Response>) | undefined;
Object.defineProperty(Deno, "serve", { configurable: true, value: (handler: typeof application) => { application = handler; return {}; } });
// Replaced by the harness with a literal import, so the complete deployment graph
// is loaded by the Edge runtime without changing any module under test.
await import("__BUNDLE_ENTRY__");
if (!application) throw new Error("Real bundle did not register Deno.serve");
const { agentedgeWritePolicy } = await import("__POLICY_ENTRY__");
const { serviceClient } = await import("__UTIL_ENTRY__");
nativeServe(async (request: Request) => {
  events = [];
  let response: Response;
  if (new URL(request.url).pathname.endsWith("/__guard_test_policy")) {
    if (request.headers.get("x-worker-secret") !== testSecret) response = respond({ error: "fixture auth" }, 403);
    else {
      const { userId } = await request.json();
      response = respond(await agentedgeWritePolicy(serviceClient(), userId));
    }
  } else response = await application!(request);
  const headers = new Headers(response.headers);
  headers.set("x-mcc-runtime-events", btoa(JSON.stringify(events)));
  headers.set("x-mcc-runtime-version", JSON.stringify(Deno.version));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
});
