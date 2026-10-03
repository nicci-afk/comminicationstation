// Local review candidate. Database triggers enforce generation and claim ownership.
import type { SupabaseClient } from "@supabase/supabase-js";
import { json, requireWorkerAuth, serviceClient } from "./_shared/util.ts";

export const SYNC_GENERATION = "gmail-sync-checkpoints-g1";
export interface SyncJob {
  msg_id: number;
  read_ct: number;
  message: Record<string, unknown>;
  claim_token: string;
  attempt: number;
}

export async function runSyncWorker(
  req: Request,
  handler: (db: SupabaseClient, job: SyncJob) => Promise<void>,
): Promise<Response> {
  const db = serviceClient({ kind: "worker" });
  await requireWorkerAuth(req, db);
  const start = Date.now();
  let processed = 0;
  while (Date.now() - start < 110_000) {
    const { data, error } = await db.rpc("claim_sync_jobs_v1", {
      p_generation: SYNC_GENERATION, p_n: 1, p_vt: 150,
    });
    if (error) throw new Error(`claim_sync_jobs_v1: ${error.message}`);
    const jobs = (data ?? []) as SyncJob[];
    if (!Array.isArray(jobs)) throw new Error("Invalid sync claim response");
    if (jobs.length === 0) break;
    for (const job of jobs) {
      if (Date.now() - start >= 110_000) break;
      if (!Number.isSafeInteger(job.msg_id) || job.msg_id <= 0 ||
          !Number.isSafeInteger(job.attempt) || job.attempt <= 0 ||
          typeof job.claim_token !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.claim_token)) {
        throw new Error("Invalid sync claim ownership");
      }
      try {
        const dead = job.attempt > 4;
        if (!dead) {
          const jobDb = serviceClient({ kind: "sync", generation: SYNC_GENERATION,
            jobId: job.msg_id, claimToken: job.claim_token });
          await handler(jobDb, job);
        }
        const { error: finishError } = await db.rpc("finish_sync_job_v1", {
          p_generation: SYNC_GENERATION, p_msg_id: job.msg_id,
          p_claim_token: job.claim_token,
          p_error: dead ? "max generation attempts exceeded" : null,
        });
        if (finishError) throw new Error(`finish_sync_job_v1: ${finishError.message}`);
        if (!dead) processed++;
      } catch (e) {
        // Never fall back to legacy ack/claim. Pause/token loss leaves the
        // durable job for redelivery; unchanged pgmq visibility applies.
        console.error(`sync_jobs job ${job.msg_id} failed:`, e);
      }
    }
  }
  return json({ ok: true, processed });
}
