// Shared helpers for all edge functions.

import { createClient, SupabaseClient } from "@supabase/supabase-js";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  };
}

export function handleOptions(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  return null;
}

// Resolve the calling user from their JWT (functions deployed with
// verify_jwt=true have already validated the signature; we still resolve the
// user via the auth API to get a trustworthy id).
export async function requireUser(
  req: Request,
  db: SupabaseClient,
): Promise<{ userId: string; email: string }> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) {
    throw new HttpError(401, "not authenticated");
  }
  return { userId: data.user.id, email: data.user.email ?? "" };
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function getConfig(
  db: SupabaseClient,
  key: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await db.rpc("get_app_config", { p_key: key });
  if (error) throw new Error(`get_app_config(${key}): ${error.message}`);
  return (data as Record<string, unknown>) ?? null;
}

export async function setConfig(
  db: SupabaseClient,
  key: string,
  value: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.rpc("set_app_config", { p_key: key, p_value: value });
  if (error) throw new Error(`set_app_config(${key}): ${error.message}`);
}

export async function readVaultSecret(
  db: SupabaseClient,
  id: string,
): Promise<string | null> {
  const { data, error } = await db.rpc("vault_read_secret", { p_id: id });
  if (error) throw new Error(`vault_read_secret: ${error.message}`);
  return (data as string) ?? null;
}

export async function getUserSecret(
  db: SupabaseClient,
  userId: string,
  kind: string,
): Promise<string | null> {
  const { data, error } = await db.rpc("get_user_secret", {
    p_user: userId,
    p_kind: kind,
  });
  if (error) throw new Error(`get_user_secret(${kind}): ${error.message}`);
  return (data as string) ?? null;
}

// Workers are called by pg_net (cron/pokes) with the anon JWT satisfying
// platform verify_jwt, plus this app-level shared secret.
export async function requireWorkerAuth(
  req: Request,
  db: SupabaseClient,
): Promise<void> {
  const presented = req.headers.get("x-worker-secret") ?? "";
  // Fast path 1: dedicated WORKER_SECRET env var (set via Supabase secrets management).
  const envSecret = Deno.env.get("WORKER_SECRET");
  if (envSecret) {
    if (presented !== envSecret) throw new HttpError(403, "bad worker secret");
    return;
  }
  // Fast path 2: anon key — Supabase auto-injects SUPABASE_ANON_KEY so no DB
  // calls needed. poke_worker sends v_anon as x-worker-secret when WORKER_SECRET
  // is not yet configured as a function secret.
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (anonKey && presented === anonKey) return;
  // Slow path: vault lookup (only if neither fast path matched — will hang ~3 min
  // due to PostgREST round-trip issues; kept for future compatibility only).
  const cfg = await getConfig(db, "worker_secret_vault_id");
  const id = cfg?.id as string | undefined;
  if (!id) throw new HttpError(500, "worker secret not configured");
  const expected = await readVaultSecret(db, id);
  if (!expected || presented !== expected) {
    throw new HttpError(403, "bad worker secret");
  }
}

export async function checkSpend(
  db: SupabaseClient,
  userId: string,
  purpose: string,
  estimatedUsd: number,
): Promise<{ allowed: boolean; reason: string }> {
  const { data, error } = await db.rpc("check_spend", {
    p_user: userId,
    p_purpose: purpose,
    p_estimated_usd: estimatedUsd,
  });
  if (error) throw new Error(`check_spend: ${error.message}`);
  return data as { allowed: boolean; reason: string };
}

export async function recordSpend(
  db: SupabaseClient,
  args: {
    userId: string;
    provider: string;
    model: string;
    purpose: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    refType?: string;
    refId?: string | null;
  },
): Promise<void> {
  const { error } = await db.rpc("record_spend", {
    p_user: args.userId,
    p_provider: args.provider,
    p_model: args.model,
    p_purpose: args.purpose,
    p_tokens_in: args.tokensIn,
    p_tokens_out: args.tokensOut,
    p_cost: args.costUsd,
    p_ref_type: args.refType ?? null,
    p_ref: args.refId ?? null,
  });
  if (error) throw new Error(`record_spend: ${error.message}`);
}

export async function enqueue(
  db: SupabaseClient,
  queue: string,
  msg: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.rpc("enqueue_and_poke", {
    p_queue: queue,
    p_msg: msg,
  });
  if (error) throw new Error(`enqueue(${queue}): ${error.message}`);
}

export interface Job {
  msg_id: number;
  read_ct: number;
  message: Record<string, unknown>;
}

export async function claimJobs(
  db: SupabaseClient,
  queue: string,
  n: number,
  vtSeconds: number,
): Promise<Job[]> {
  const { data, error } = await db.rpc("claim_jobs", {
    p_queue: queue,
    p_n: n,
    p_vt: vtSeconds,
  });
  if (error) throw new Error(`claim_jobs(${queue}): ${error.message}`);
  return (data ?? []) as Job[];
}

export async function ackJob(db: SupabaseClient, queue: string, msgId: number) {
  const { error } = await db.rpc("ack_job", { p_queue: queue, p_msg_id: msgId });
  if (error) throw new Error(`ack_job: ${error.message}`);
}

export async function deadLetterJob(
  db: SupabaseClient,
  queue: string,
  job: Job,
  errMsg: string,
) {
  const { error } = await db.rpc("dead_letter_job", {
    p_queue: queue,
    p_msg_id: job.msg_id,
    p_message: job.message,
    p_error: errMsg.slice(0, 2000),
  });
  if (error) throw new Error(`dead_letter_job: ${error.message}`);
}

export const MAX_JOB_ATTEMPTS = 4;

// Standard worker wrapper: auth → drain within a wall-clock budget → 200.
export async function runWorker(
  req: Request,
  queue: string,
  vtSeconds: number,
  budgetMs: number,
  handler: (db: SupabaseClient, job: Job) => Promise<void>,
): Promise<Response> {
  const db = serviceClient();
  await requireWorkerAuth(req, db);
  const start = Date.now();
  let processed = 0;
  while (Date.now() - start < budgetMs) {
    const jobs = await claimJobs(db, queue, 3, vtSeconds);
    if (jobs.length === 0) break;
    for (const job of jobs) {
      if (Date.now() - start >= budgetMs) break;
      if (job.read_ct > MAX_JOB_ATTEMPTS) {
        await deadLetterJob(db, queue, job, "max attempts exceeded");
        continue;
      }
      try {
        await handler(db, job);
        await ackJob(db, queue, job.msg_id);
        processed++;
      } catch (e) {
        // leave unacked: visibility timeout will redeliver; read_ct escalates
        console.error(`${queue} job ${job.msg_id} failed:`, e);
      }
    }
  }
  return json({ ok: true, processed });
}
