// Manual "Analyze contact" trigger — the ONLY way a pipeline run starts.
// Verifies ownership, requires all three vendor keys, enforces spend caps and
// the single-flight lock, then enqueues stage 1.

import {
  checkSpend,
  enqueue,
  getUserSecret,
  handleOptions,
  HttpError,
  json,
  requireUser,
  serviceClient,
} from "./_shared/util.ts";

const EST_PIPELINE_COST = 0.3;

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  const db = serviceClient();
  try {
    const { userId } = await requireUser(req, db);
    const body = await req.json();
    const contactId = body.contact_id as string;
    const businessId = (body.business_id as string) ?? null;
    const channel = (body.channel as string) ?? "email";
    const overrides = (body.overrides ?? {}) as Record<string, unknown>;

    const { data: contact } = await db
      .from("contacts")
      .select("id,user_id,display_name,kind")
      .eq("id", contactId)
      .maybeSingle();
    if (!contact || contact.user_id !== userId) {
      throw new HttpError(404, "contact not found");
    }
    if (contact.kind === "automated") {
      throw new HttpError(400, "this sender is automated — the pipeline only analyzes people");
    }

    const missing: string[] = [];
    for (const kind of ["perplexity_api_key", "openai_api_key", "anthropic_api_key"]) {
      if (!(await getUserSecret(db, userId, kind))) missing.push(kind);
    }
    if (missing.length) {
      throw new HttpError(400, `missing API keys in Settings: ${missing.join(", ")}`);
    }

    const spend = await checkSpend(db, userId, "pipeline_stage1", EST_PIPELINE_COST);
    if (!spend.allowed) throw new HttpError(402, `spend cap: ${spend.reason}`);

    let link: { relationship_context?: string; stakes_level?: string } | null = null;
    if (businessId) {
      const { data } = await db
        .from("contact_business_links")
        .select("relationship_context,stakes_level")
        .eq("contact_id", contactId)
        .eq("business_id", businessId)
        .maybeSingle();
      link = data;
    }

    const analyzeRequest = {
      source_profile_id: contactId,
      target_label: (overrides.target_label as string) ?? contact.display_name,
      full_name: (overrides.full_name as string) ?? contact.display_name,
      aliases: (overrides.aliases as string[]) ?? [],
      profile_urls: (overrides.profile_urls as string[]) ?? [],
      location: (overrides.location as string[]) ?? [],
      employer: (overrides.employer as string[]) ?? [],
      industry: (overrides.industry as string[]) ?? [],
      use_case: (overrides.use_case as string) ??
        "ongoing business correspondence with this contact",
      relationship_context: (overrides.relationship_context as string) ??
        link?.relationship_context ?? "existing business contact",
      stakes_level: ((overrides.stakes_level as string) ?? link?.stakes_level ?? "medium") as
        | "low" | "medium" | "high",
      desired_outcome: (overrides.desired_outcome as string) ??
        "maintain a productive relationship and move current threads forward",
      channel: channel as "text" | "dm" | "email" | "call" | "in_person" | "other",
      known_user_goal: overrides.known_user_goal as string | undefined,
      interaction_history_summary: overrides.interaction_history_summary as string | undefined,
    };

    const { data: run, error } = await db
      .from("pipeline_runs")
      .insert({
        user_id: userId,
        contact_id: contactId,
        business_id: businessId,
        channel,
        trigger_reason: (body.trigger_reason as string) ?? "manual",
        status: "queued",
        analyze_request: analyzeRequest,
      })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") {
        throw new HttpError(409, "an analysis is already running for this contact");
      }
      throw new Error(error.message);
    }

    await enqueue(db, "pipeline_jobs", { run_id: run.id, stage: 1 });
    return json({ run_id: run.id });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
}
