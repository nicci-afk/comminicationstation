// One-shot migration: reads client_briefs from AgentEdge and imports them as
// contact strategies into the Command Center. Matches by email; creates
// pipeline_artifacts (stage 3) + contact_strategies. Safe to re-run:
// duplicate email matches are skipped via ON CONFLICT DO NOTHING.

import {
  getUserSecret,
  handleOptions,
  HttpError,
  json,
  requireUser,
  serviceClient,
} from "./_shared/util.ts";

const AGENTEDGE_URL = "https://iitrvppynxisvhztbybw.supabase.co";

// DISC → tone/approach mapping
const DISC_TONE: Record<string, { tones: string[]; avoid: string[]; opening: string }> = {
  D: { tones: ["direct", "brief", "results-focused"], avoid: ["lengthy process detail", "small talk"], opening: "Lead with the outcome." },
  I: { tones: ["warm", "enthusiastic", "personal"], avoid: ["dry data only", "impersonal formality"], opening: "Open with their story or the experience." },
  S: { tones: ["patient", "consistent", "reassuring"], avoid: ["urgency", "surprise changes"], opening: "Acknowledge their need for calm and reliability." },
  C: { tones: ["precise", "evidence-based", "documented"], avoid: ["vague claims", "pressure tactics"], opening: "Present facts and a clear rationale first." },
};

function buildCommOutput(brief: Record<string, unknown>): Record<string, unknown> {
  const discPrimary = (brief.disc_primary as string | null) ?? "";
  const discSecondary = (brief.disc_secondary as string | null) ?? "";
  const primaryTone = DISC_TONE[discPrimary];
  const secondaryTone = DISC_TONE[discSecondary];

  const recommendedTone = primaryTone
    ? [...primaryTone.tones, ...(secondaryTone ? [secondaryTone.tones[0]] : [])]
    : [];
  const avoidTone = primaryTone ? primaryTone.avoid : [];

  const whyConverts = (brief.why_converts as string | null) ?? "";
  const correspondenceSummary = (brief.correspondence_summary as string | null) ?? "";
  const nextBestAction = (brief.next_best_action as string | null) ?? "";
  const proposalShape = (brief.recommended_proposal_shape as string | null) ?? "";

  const recommendedApproach = whyConverts || proposalShape || correspondenceSummary.slice(0, 300);

  const conversionHooks = (brief.conversion_hooks as unknown[] | null) ?? [];
  const frictionPoints = (brief.friction_points as unknown[] | null) ?? [];

  const langDo = conversionHooks
    .filter((h) => typeof h === "object" && h !== null)
    .map((h) => (h as Record<string, unknown>).hook ?? String(h))
    .filter((h) => typeof h === "string")
    .slice(0, 6) as string[];

  const langAvoid = frictionPoints
    .filter((f) => typeof f === "object" && f !== null)
    .map((f) => (f as Record<string, unknown>).point ?? String(f))
    .filter((f) => typeof f === "string")
    .slice(0, 6) as string[];

  const openingOption = primaryTone?.opening
    ? { option: primaryTone.opening, use_when: "initial or re-engagement contact" }
    : null;

  return {
    recommended_approach: recommendedApproach || null,
    tone_profile: recommendedTone.length > 0
      ? { recommended_tone: recommendedTone, avoid_tone: avoidTone }
      : null,
    opening_options: openingOption ? [openingOption] : [],
    language_do: langDo,
    language_avoid: langAvoid,
    // Provenance + full AgentEdge data for reference
    _source: "agentedge_migration",
    _disc_primary: discPrimary || null,
    _disc_secondary: discSecondary || null,
    _budget_tier: brief.budget_tier ?? null,
    _avg_trip_value: brief.avg_trip_value ?? null,
    _lifetime_spend: brief.lifetime_spend ?? null,
    _n_trips: brief.n_trips ?? null,
    _correspondence_summary: correspondenceSummary || null,
    _next_best_action: nextBestAction || null,
    _readiness: brief.readiness ?? null,
    _profile_confidence: brief.profile_confidence ?? null,
    _observed_style: brief.observed_style ?? null,
  };
}

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  const db = serviceClient();

  try {
    const { userId } = await requireUser(req, db);

    const aeKey = await getUserSecret(db, userId, "agentedge_service_key");
    if (!aeKey) throw new HttpError(400, "Add your AgentEdge service role key in Settings → API keys first");

    // Fetch client_briefs joined with crm_clients from AgentEdge
    const resp = await fetch(
      `${AGENTEDGE_URL}/rest/v1/client_briefs?select=*,crm_clients!inner(first_name,last_name,email,alt_emails)&order=id&limit=500`,
      { headers: { Authorization: `Bearer ${aeKey}`, apikey: aeKey } },
    );
    if (!resp.ok) {
      const t = await resp.text();
      throw new HttpError(502, `AgentEdge ${resp.status}: ${t.slice(0, 200)}`);
    }

    type AeBrief = Record<string, unknown> & { crm_clients: { first_name?: string; last_name?: string; email?: string; alt_emails?: string[] } };
    const briefs = await resp.json() as AeBrief[];

    let matched = 0, skipped = 0, created = 0, errors = 0;

    for (const brief of briefs) {
      const client = brief.crm_clients;
      const emails: string[] = [
        ...(client.email ? [client.email.toLowerCase()] : []),
        ...(client.alt_emails ?? []).map((e) => e.toLowerCase()),
      ].filter((e) => e.includes("@"));

      if (emails.length === 0) { skipped++; continue; }

      // Skip entries with no meaningful strategy data
      const hasData = brief.disc_primary || brief.correspondence_summary || brief.conversion_hooks;
      if (!hasData) { skipped++; continue; }

      // Find matching MCC contact by email channel
      const { data: channel } = await db
        .from("contact_channels")
        .select("contact_id")
        .eq("user_id", userId)
        .eq("channel_type", "email")
        .in("canonical_value", emails)
        .limit(1)
        .maybeSingle();

      if (!channel) { skipped++; continue; }
      matched++;

      const contactId = channel.contact_id as string;

      // Skip if strategy already exists for this contact
      const { data: existing } = await db
        .from("contact_strategies")
        .select("id")
        .eq("user_id", userId)
        .eq("contact_id", contactId)
        .maybeSingle();

      if (existing) { skipped++; continue; }

      // Determine allowed_zone
      const profileConfirmed = brief.profile_confirmed as boolean | null;
      const allowedZone = (profileConfirmed || brief.disc_primary) ? "green" : "yellow";

      try {
        // Create pipeline_artifact (stage 3 = comm strategy)
        const { data: artifact, error: artErr } = await db
          .from("pipeline_artifacts")
          .insert({
            user_id: userId,
            contact_id: contactId,
            run_id: crypto.randomUUID(),
            stage: 3,
            prompt_id: "agentedge_migration_v1",
            input_schema_version: "agentedge_migration_v1",
            output_schema_version: "agentedge_migration_v1",
            input: { _source: "agentedge_migration" },
            output: buildCommOutput(brief as Record<string, unknown>),
            provider: "agentedge_migration",
            model: "none",
            tokens_in: 0,
            tokens_out: 0,
            cost_usd: 0,
            attempt: 1,
            qc_passed: true,
            allowed_zone: allowedZone,
          })
          .select("id")
          .single();

        if (artErr) throw new Error(artErr.message);

        // Create contact_strategy
        const { error: csErr } = await db.from("contact_strategies").insert({
          user_id: userId,
          contact_id: contactId,
          status: "active",
          comm_artifact_id: artifact.id,
          allowed_zone: allowedZone,
          drift_status: "stable",
          re_analysis_recommended: false,
        });

        if (csErr) throw new Error(csErr.message);
        created++;
      } catch (e) {
        console.error(`strategy import failed for contact ${contactId}:`, e);
        errors++;
      }
    }

    return json({
      ok: true,
      total_ae_briefs: briefs.length,
      matched_to_mcc_contact: matched,
      strategies_created: created,
      skipped,
      errors,
    });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
}
