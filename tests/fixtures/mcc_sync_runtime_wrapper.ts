// LOCAL VALIDATION ONLY. Never deploy. The complete workers graph under bundle/
// is unmodified; this separate wrapper intercepts synthetic Google HTTP only.
// All database requests use native fetch and real local PostgREST transactions.
const nativeFetch = globalThis.fetch.bind(globalThis);
const nativeServe = Deno.serve.bind(Deno);
const NativeDate = Date;
const local = new URL(Deno.env.get("SUPABASE_URL")!);
if (local.protocol !== "http:" || !/^(kong|localhost|127\.0\.0\.1|supabase_kong_[a-z0-9_-]+)$/.test(local.hostname)) {
  throw new Error("Sync fixture refuses a non-local Supabase URL");
}
const secret = Deno.env.get("WORKER_SECRET");
if (!secret?.startsWith("mcc-local-fixture-")) throw new Error("Synthetic local worker secret required");
type Reply = { body: Record<string, unknown>; status?: number; advanceMs?: number };
type Scenario = { pages?: Record<string, Reply>; messages?: Record<string, Reply>; oauthStatus?: number; profile?: Reply; list?: Reply; watch?: Reply; advanceOnMetadata?: number; now?: string };
let scenario: Scenario = {};
let clock = NativeDate.parse("2026-10-02T19:00:00.123Z");
let events: Record<string, unknown>[] = [];
let active = false;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
globalThis.Date = new Proxy(NativeDate, {
  construct(target, args) { return Reflect.construct(target, args.length ? args : [clock]); },
  get(target, key, receiver) { return key === "now" ? () => clock : Reflect.get(target, key, receiver); },
});
function synthetic(reply: Reply): Response {
  const step = reply.advanceMs ?? 0;
  if (!Number.isSafeInteger(step) || step < 0 || step > 200_000) throw new Error("Invalid fixture clock advance");
  clock += step;
  return json(reply.body, reply.status ?? 200);
}
globalThis.fetch = async (input: Request | URL | string, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin === local.origin) {
    // No response substitution, fabricated client, or production DB adapter.
    // Record request shape only; never log authorization or fake vault values.
    const event: Record<string, unknown> = { kind: "local_fetch", path: url.pathname, query: url.search, method: request.method };
    if (request.method === "PATCH") event.patch = await request.clone().json();
    if (url.pathname.endsWith("/enqueue_and_poke")) {
      const value = await request.clone().json();
      event.queue = value.p_queue;
    }
    events.push(event);
    const response = await nativeFetch(new Request(request, { redirect: "error" }));
    event.status = response.status;
    return response;
  }
  if (!active) throw new Error("Remote request outside synthetic scenario");
  if (url.href === "https://oauth2.googleapis.com/token" && request.method === "POST") {
    const form = new URLSearchParams(await request.text());
    if (form.get("client_id") !== "mcc-fixture-client" || form.get("client_secret") !== "mcc-fixture-value" || form.get("refresh_token") !== "mcc-fixture-value" || form.get("grant_type") !== "refresh_token") {
      throw new Error("Only synthetic Google OAuth inputs are permitted");
    }
    events.push({ kind: "synthetic_oauth", status: scenario.oauthStatus ?? 200 });
    return scenario.oauthStatus ? json({ error: "invalid_grant" }, scenario.oauthStatus) : json({ access_token: "mcc-fixture-access-token" });
  }
  if (url.origin === "https://gmail.googleapis.com" && request.headers.get("authorization") === "Bearer mcc-fixture-access-token") {
    const route = url.pathname.replace(/^\/gmail\/v1/, "");
    events.push({ kind: "synthetic_gmail", path: route, query: url.search, method: request.method });
    if (request.method === "GET" && route === "/users/me/history") {
      const key = url.searchParams.get("pageToken") ?? "first";
      const reply = scenario.pages?.[key];
      if (!reply) throw new Error(`Unspecified synthetic history page: ${key}`);
      return synthetic(reply);
    }
    if (request.method === "GET" && route.startsWith("/users/me/messages/")) {
      const id = route.slice("/users/me/messages/".length);
      if (!/^[a-z0-9-]+$/.test(id)) throw new Error("Invalid synthetic provider id");
      return synthetic(scenario.messages?.[id] ?? { advanceMs: scenario.advanceOnMetadata, body: {
        id, threadId: `thread-${id}`, internalDate: "1790966400000", labelIds: ["INBOX", "UNREAD"],
        payload: { headers: [{ name: "From", value: "sender@example.invalid" }, { name: "To", value: "owner@example.invalid" }, { name: "Subject", value: "LOCAL SYNC RUNTIME FIXTURE" }] },
      } });
    }
    if (request.method === "GET" && route === "/users/me/profile" && scenario.profile) return synthetic(scenario.profile);
    if (request.method === "GET" && route === "/users/me/messages" && scenario.list) return synthetic(scenario.list);
    if (request.method === "POST" && route === "/users/me/watch" && scenario.watch) return synthetic(scenario.watch);
  }
  events.push({ kind: "blocked_egress", origin: url.origin, path: url.pathname });
  throw new Error("Sync runtime fixture blocks all non-local, non-synthetic egress");
};
// Defense in depth for alternate application-level transports. Runtime module
// loading is performed by the loader, not these application network APIs.
for (const key of ["connect", "connectTls", "createHttpClient", "resolveDns"]) {
  if (key in Deno) Object.defineProperty(Deno, key, { configurable: true, value: () => {
    events.push({ kind: "blocked_egress", transport: `Deno.${key}` });
    throw new Error(`Sync fixture blocks Deno.${key}`);
  } });
}
if ("WebSocket" in globalThis) Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class {
  constructor() { events.push({ kind: "blocked_egress", transport: "WebSocket" }); throw new Error("Sync fixture blocks WebSocket"); }
} });
let application: ((req: Request) => Response | Promise<Response>) | undefined;
Object.defineProperty(Deno, "serve", { configurable: true, value: (handler: typeof application) => { application = handler; return {}; } });
await import("__BUNDLE_ENTRY__");
if (!application) throw new Error("Exact workers graph did not register Deno.serve");
// Serialize fixture controls. This protects global fake time/scenario even if a
// caller overlaps requests; real DB race effects are induced by SQL fixture RPCs.
let pending = Promise.resolve();
nativeServe(async (request: Request) => {
  const previous = pending;
  let release!: () => void;
  pending = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    events = [];
    scenario = {};
    clock = NativeDate.parse("2026-10-02T19:00:00.123Z");
    if (request.headers.get("x-worker-secret") === secret && request.method === "POST") {
      const value = await request.clone().json();
      scenario = value.scenario ?? {};
      if (scenario.now) clock = NativeDate.parse(scenario.now);
      if (!Number.isFinite(clock)) throw new Error("Invalid fixture clock");
    }
    active = true;
    const url = new URL(request.url);
    // Preserve the real workers router's expected function segment.
    url.pathname = url.pathname.replace("/sync-runtime/", "/workers/");
    const response = await application!(new Request(url, request));
    const body = await response.json();
    return new Response(JSON.stringify({ application: body, events, runtime: Deno.version }), {
      status: response.status, headers: { "content-type": "application/json", "x-mcc-sync-runtime": "1" },
    });
  } finally { active = false; release(); }
});
