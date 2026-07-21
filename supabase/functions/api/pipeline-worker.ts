// Executes ONE pipeline stage per job (never more — edge function wall-clock
// limits make a monolithic 3-stage run a timeout bomb). Flow per stage:
// claim → cap check → vendor call → zod validation → code-enforced QC gates →
// one auto-repair retry on failure → persist artifact → enqueue next stage.
// The model's self-reported qc_status is stored but NEVER trusted as the gate.

import { SupabaseClient } from "@supabase/supabase-js";
import {
  checkSpend,
  getConfig,
  getUserSecret,
  handleOptions,
  MAX_JOB_ATTEMPTS,
  recordSpend,
  runWorker,
} from "./_shared/util.ts";
import { callAnthropic, callOpenAI, callPerplexity, LlmResult } from "./_shared/llm.ts";
import { COMM_SYSTEM, PERPLEXITY_SYSTEM, PERSONA_SYSTEM, repairPrompt } from "./_shared/prompts.ts";
import {
  AnalyzeRequest,
  buildCommInput,
  buildPersonaInput,
  buildPerplexityInput,
} from "./_shared/schemas/packets.ts";
import { PerplexityOutput } from "./_shared/schemas/perplexity.ts";
import { PersonaOutput } from "./_shared/schemas/persona.ts";
import { CommOutput } from "./_shared/schemas/comm.ts";
import { qcComm, qcPerplexity, qcPersona, QcResult } from "./_shared/schemas/qc.ts";

const DEFAULT_MODELS = { stage1: "sonar-pro", stage2: "gpt-5.1", stage3: "claude-opus-4-8" };
const ZONE_RANK: Record<string, number> = { green: 0, yellow: 1, red: 2 };

interface RunRow {
  id: string;
  user_id: string;
  contact_id: string;
  business_id: string | null;
  channel: string;
  status: string;
  analyze_request: AnalyzeRequest;
}

async function models(db: SupabaseClient): Promise<typeof DEFAULT_MODELS> {
  const cfg = await getConfig(db, "pipeline_models");
  return { ...DEFAULT_MODELS, ...((cfg ?? {}) as Partial<typeof DEFAULT_MODELS>) };
}

interface StageOutcome {
  ok: boolean;
  output: unknown;
  qc: QcResult;
  modelQc: unknown;
  allowedZone: string | null;
  artifacts: { result: LlmResult; attempt: number; qc: QcResult }[];
}

// Generic stage executor with one repair retry.
async function executeStage(
  call: (user: string) => Promise<LlmResult>,
  input: unknown,
  validate: (parsed: unknown) => { problems: string[]; output: unknown; qc: QcResult; modelQc: unknown; zone: string | null },
): Promise<StageOutcome> {
  const artifacts: StageOutcome["artifacts"] = [];
  let result = await call(JSON.stringify(input));
  let v = validate(result.parsed);
  artifacts.push({ result, attempt: 1, qc: v.qc });
  if (v.problems.length > 0) {
    result = await call(
      JSON.stringify(input) + "\n\n" + repairPrompt(result.raw.slice(0, 12_000), v.problems),
    );
    v = validate(result.parsed);
    artifacts.push({ result, attempt: 2, qc: v.qc });
  }
  return {
    ok: v.problems.length === 0,
    output: v.output,
    qc: v.qc,
    modelQc: v.modelQc,
    allowedZone: v.zone,
    artifacts,
  };
}

async function persistArtifacts(
  db: SupabaseClient,
  run: RunRow,
  stage: number,
  promptId: string,
  inputVersion: string,
  outputVersion: string,
  input: unknown,
  outcome: StageOutcome,
) {
  for (const a of outcome.artifacts) {
    const { error } = await db.from("pipeline_artifacts").insert({
      user_id: run.user_id,
      run_id: run.id,
      contact_id: run.contact_id,
      stage,
      prompt_id: promptId,
      input_schema_version: inputVersion,
      output_schema_version: outputVersion,
      input,
      output: a.result.parsed ?? null,
      provider: a.result.provider,
      model: a.result.model,
      tokens_in: a.result.tokensIn,
      tokens_out: a.result.tokensOut,
      cost_usd: a.result.costUsd,
      attempt: a.attempt,
      qc_passed: a.qc.passed,
      qc_fail_reasons: a.qc.fail_reasons,
      model_qc_status: (a.result.parsed as { qc_status?: unknown })?.qc_status ?? null,
      allowed_zone: outcome.allowedZone,
    });
    if (error) throw new Error(`artifact insert: ${error.message}`);
    await recordSpend(db, {
      userId: run.user_id,
      provider: a.result.provider,
      model: a.result.model,
      purpose: `pipeline_stage${stage}`,
      tokensIn: a.result.tokensIn,
      tokensOut: a.result.tokensOut,
      costUsd: a.result.costUsd,
      refType: "pipeline_run",
      refId: run.id,
    });
  }
}

async function latestPassingArtifact(db: SupabaseClient, runId: string, stage: number) {
  const { data } = await db
    .from("pipeline_artifacts")
    .select("id,output,allowed_zone")
    .eq("run_id", runId)
    .eq("stage", stage)
    .eq("qc_passed", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function failRun(db: SupabaseClient, runId: string, status: string, error: string) {
  await db
    .from("pipeline_runs")
    .update({ status, error: error.slice(0, 2000), finished_at: new Date().toISOString() })
    .eq("id", runId);
}

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  return await runWorker(req, "pipeline_jobs", 240, 200_000, async (db, job) => {
    const runId = job.message.run_id as string;
    const stage = Number(job.message.stage);
    const { data: runData } = await db.from("pipeline_runs").select("*").eq("id", runId).maybeSingle();
    const run = runData as RunRow | null;
    if (!run) return;

    const expectedBefore: Record<number, string[]> = {
      1: ["queued", "stage1_running"],
      2: ["stage1_done", "stage2_running"],
      3: ["stage2_done", "stage3_running"],
    };
    if (!expectedBefore[stage]?.includes(run.status)) return; // stale/duplicate job

    try {
      const spend = await checkSpend(db, run.user_id, `pipeline_stage${stage}`, 0.15);
      if (!spend.allowed) {
        await failRun(db, runId, "error", `spend cap: ${spend.reason}`);
        return;
      }
      await db.from("pipeline_runs").update({
        status: `stage${stage}_running`,
        current_stage: stage,
        started_at: run.status === "queued" ? new Date().toISOString() : undefined,
      }).eq("id", runId);

      const m = await models(db);
      const req_ = run.analyze_request;

      if (stage === 1) {
        const apiKey = (await getUserSecret(db, run.user_id, "perplexity_api_key"))!;
        const input = buildPerplexityInput(req_);
        const outcome = await executeStage(
          (user) => callPerplexity({ apiKey, model: m.stage1, system: PERPLEXITY_SYSTEM, user, maxTokens: 6000 }),
          input,
          (parsed) => {
            const z = PerplexityOutput.safeParse(parsed);
            if (!z.success) {
              return {
                problems: z.error.issues.slice(0, 20).map((i) => `${i.path.join(".")}: ${i.message}`),
                output: parsed, qc: { passed: false, fail_reasons: ["schema invalid"] }, modelQc: null, zone: null,
              };
            }
            const qc = qcPerplexity(z.data);
            return {
              problems: qc.passed ? [] : qc.fail_reasons,
              output: z.data, qc, modelQc: z.data.qc_status,
              zone: z.data.handoff_packet.allowed_strategy_zone,
            };
          },
        );
        await persistArtifacts(db, run, 1, "perplexity_research_v1", "perplexity_input_v1", "perplexity_output_v1", input, outcome);
        if (!outcome.ok) {
          await failRun(db, runId, "qc_failed", `stage 1 QC: ${outcome.qc.fail_reasons.join("; ")}`);
          return;
        }
        await db.from("pipeline_runs").update({ status: "stage1_done" }).eq("id", runId);
        await db.rpc("enqueue_and_poke", { p_queue: "pipeline_jobs", p_msg: { run_id: runId, stage: 2 } });
      }

      if (stage === 2) {
        const apiKey = (await getUserSecret(db, run.user_id, "openai_api_key"))!;
        const prev = await latestPassingArtifact(db, runId, 1);
        if (!prev) { await failRun(db, runId, "error", "stage 1 artifact missing"); return; }
        const s1 = prev.output as Record<string, unknown>;
        const handoff = s1.handoff_packet as Record<string, unknown>;
        const upstreamZone = String(handoff.allowed_strategy_zone ?? "yellow");
        // Compact evidence capsule per the downstream contract (no raw dumps).
        const capsule = {
          observable_signals: ((s1.observable_signals as unknown[]) ?? []).slice(0, 14),
          contradictions: s1.contradictions ?? [],
          uncertainty_map: ((s1.uncertainty_map as unknown[]) ?? []).slice(0, 8),
          identity_resolution_status: (s1.identity_resolution as Record<string, unknown>)?.status,
        };
        const input = buildPersonaInput(req_, handoff, capsule);
        const outcome = await executeStage(
          (user) => callOpenAI({ apiKey, model: m.stage2, system: PERSONA_SYSTEM, user, maxTokens: 6000 }),
          input,
          (parsed) => {
            const z = PersonaOutput.safeParse(parsed);
            if (!z.success) {
              return {
                problems: z.error.issues.slice(0, 20).map((i) => `${i.path.join(".")}: ${i.message}`),
                output: parsed, qc: { passed: false, fail_reasons: ["schema invalid"] }, modelQc: null, zone: null,
              };
            }
            const qc = qcPersona(z.data);
            const problems = qc.passed ? [] : [...qc.fail_reasons];
            const zone = z.data.claude_handoff_packet.allowed_strategy_zone;
            if (ZONE_RANK[zone] < ZONE_RANK[upstreamZone]) {
              problems.push(
                `allowed_strategy_zone '${zone}' is less restrictive than upstream '${upstreamZone}' (may not override upstream evidence boundaries)`,
              );
            }
            return { problems, output: z.data, qc, modelQc: z.data.qc_status, zone };
          },
        );
        await persistArtifacts(db, run, 2, "chatgpt_persona_strategy_v1", "chatgpt_persona_input_v1", "chatgpt_persona_output_v1", input, outcome);
        if (!outcome.ok) {
          await failRun(db, runId, "qc_failed", `stage 2 QC: ${outcome.qc.fail_reasons.join("; ")}`);
          return;
        }
        await db.from("pipeline_runs").update({ status: "stage2_done" }).eq("id", runId);
        await db.rpc("enqueue_and_poke", { p_queue: "pipeline_jobs", p_msg: { run_id: runId, stage: 3 } });
      }

      if (stage === 3) {
        const apiKey = (await getUserSecret(db, run.user_id, "anthropic_api_key"))!;
        const prev = await latestPassingArtifact(db, runId, 2);
        if (!prev) { await failRun(db, runId, "error", "stage 2 artifact missing"); return; }
        const s2 = prev.output as Record<string, unknown>;
        const handoff = s2.claude_handoff_packet as Record<string, unknown>;
        const upstreamZone = String(handoff.allowed_strategy_zone ?? "yellow");
        const upstreamDrift = ((s2.drift_tracking as Record<string, unknown>)?.drift_status as string) ?? "none";
        const input = buildCommInput(req_, handoff);
        const outcome = await executeStage(
          (user) => callAnthropic({ apiKey, model: m.stage3, system: COMM_SYSTEM, user, maxTokens: 8000, thinking: true }),
          input,
          (parsed) => {
            const z = CommOutput.safeParse(parsed);
            if (!z.success) {
              return {
                problems: z.error.issues.slice(0, 20).map((i) => `${i.path.join(".")}: ${i.message}`),
                output: parsed, qc: { passed: false, fail_reasons: ["schema invalid"] }, modelQc: null, zone: null,
              };
            }
            const qc = qcComm(z.data, {
              allowed_strategy_zone: upstreamZone as "green" | "yellow" | "red",
              drift_status: upstreamDrift,
            });
            return {
              problems: qc.passed ? [] : qc.fail_reasons,
              output: z.data, qc, modelQc: z.data.qc_status, zone: upstreamZone,
            };
          },
        );
        await persistArtifacts(db, run, 3, "claude_communication_strategy_v1", "claude_comm_input_v1", "claude_comm_output_v1", input, outcome);
        if (!outcome.ok) {
          await failRun(db, runId, "qc_failed", `stage 3 QC: ${outcome.qc.fail_reasons.join("; ")}`);
          return;
        }

        // Wire the strategy: supersede any current one for this scope.
        const s1Art = await latestPassingArtifact(db, runId, 1);
        const s2Art = await latestPassingArtifact(db, runId, 2);
        const s3Art = await latestPassingArtifact(db, runId, 3);
        const commOut = outcome.output as CommOutput;
        let supersede = db
          .from("contact_strategies")
          .update({ status: "superseded" })
          .eq("contact_id", run.contact_id)
          .eq("channel", run.channel)
          .neq("status", "superseded");
        supersede = run.business_id === null
          ? supersede.is("business_id", null)
          : supersede.eq("business_id", run.business_id);
        await supersede;
        const { error: stratErr } = await db.from("contact_strategies").insert({
          user_id: run.user_id,
          contact_id: run.contact_id,
          business_id: run.business_id,
          channel: run.channel,
          status: "active",
          perplexity_artifact_id: s1Art?.id,
          persona_artifact_id: s2Art?.id,
          comm_artifact_id: s3Art?.id,
          allowed_zone: upstreamZone,
          drift_status: commOut.drift_response_rules.drift_status,
        });
        if (stratErr) throw new Error(`strategy insert: ${stratErr.message}`);
        await db.from("pipeline_runs").update({
          status: "complete",
          finished_at: new Date().toISOString(),
        }).eq("id", runId);
      }
    } catch (e) {
      if (job.read_ct >= MAX_JOB_ATTEMPTS) {
        await failRun(db, runId, "error", (e as Error).message);
        return; // ack — do not dead-letter loop
      }
      throw e; // redeliver via visibility timeout
    }
  });
}
