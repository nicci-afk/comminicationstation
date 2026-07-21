// Contact profile + the "Analyze contact" trigger (the only place the
// expensive 3-stage pipeline can start) + full stored strategy rendering.
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Play, Star } from "lucide-react";
import { api, supabase } from "../lib/supabase";
import { fmtWhen, useArtifactOutput, useBusinesses, useContact, useStrategies } from "../lib/hooks";
import type { PipelineRun } from "../lib/types";

export default function ContactDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: contact } = useContact(id ?? null);
  const { data: strategies = [] } = useStrategies(id ?? null);
  const { data: businesses = [] } = useBusinesses();
  const [showAnalyze, setShowAnalyze] = useState(false);
  const strategy = strategies[0] ?? null;
  const { data: comm } = useArtifactOutput(strategy?.comm_artifact_id ?? null);
  const { data: persona } = useArtifactOutput(strategy?.persona_artifact_id ?? null);

  const { data: runs = [] } = useQuery({
    queryKey: ["runs", id],
    refetchInterval: (q) => {
      const data = q.state.data as PipelineRun[] | undefined;
      return data?.some((r) => !["complete", "error", "qc_failed", "cancelled"].includes(r.status)) ? 4000 : false;
    },
    queryFn: async (): Promise<PipelineRun[]> => {
      const { data, error } = await supabase
        .from("pipeline_runs")
        .select("id,contact_id,status,current_stage,error,total_cost_usd,created_at,finished_at")
        .eq("contact_id", id!)
        .order("created_at", { ascending: false })
        .limit(5);
      if (error) throw error;
      return data ?? [];
    },
  });
  const activeRun = runs.find((r) => !["complete", "error", "qc_failed", "cancelled"].includes(r.status));

  const toggleVip = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("contacts").update({ is_vip: !contact!.is_vip }).eq("id", id!);
      if (error) throw error;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["contact", id] }),
  });

  if (!contact) return <div className="p-10 text-slate-400">Loading…</div>;

  return (
    <div className="max-w-3xl mx-auto p-8">
      <button onClick={() => nav(-1)} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="w-4 h-4" /> Back
      </button>
      <div className="mt-2 flex items-center gap-3">
        <h1 className="text-2xl font-bold">{contact.display_name}</h1>
        <button onClick={() => toggleVip.mutate()} title="Toggle VIP">
          <Star className={`w-5 h-5 ${contact.is_vip ? "text-amber-500" : "text-slate-300"}`}
            fill={contact.is_vip ? "currentColor" : "none"} />
        </button>
        <span className="text-xs px-2 py-1 bg-slate-100 rounded-full text-slate-500">{contact.kind}</span>
        <span className="text-xs text-slate-400">seen {fmtWhen(contact.last_seen_at)}</span>
      </div>

      {activeRun ? (
        <div className="mt-4 bg-indigo-50 border border-indigo-200 rounded-xl p-4 text-sm">
          <div className="font-medium text-indigo-800">Analysis running — stage {activeRun.current_stage} of 3</div>
          <div className="mt-2 flex gap-1">
            {[1, 2, 3].map((s) => (
              <div key={s} className={`h-2 flex-1 rounded-full ${
                activeRun.current_stage > s || activeRun.status === `stage${s}_done` ? "bg-indigo-500"
                : activeRun.current_stage === s ? "bg-indigo-300 animate-pulse" : "bg-slate-200"}`} />
            ))}
          </div>
          <p className="mt-2 text-xs text-indigo-700">
            1 · Perplexity public-web research → 2 · persona strategy → 3 · communication strategy
          </p>
        </div>
      ) : (
        <button
          onClick={() => setShowAnalyze(true)}
          className="mt-4 flex items-center gap-2 bg-indigo-600 text-white rounded-xl px-4 py-2 text-sm font-medium hover:bg-indigo-700"
        >
          <Play className="w-4 h-4" /> {strategy ? "Re-analyze contact" : "Analyze contact"}
        </button>
      )}

      {runs[0] && ["error", "qc_failed"].includes(runs[0].status) && (
        <div className="mt-3 bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-700">
          Last run {runs[0].status === "qc_failed" ? "failed quality-control gates" : "errored"}: {runs[0].error}
        </div>
      )}

      {showAnalyze && (
        <AnalyzeDialog
          contactId={id!}
          contactName={contact.display_name}
          businesses={businesses}
          onClose={() => { setShowAnalyze(false); qc.invalidateQueries({ queryKey: ["runs", id] }); }}
        />
      )}

      {strategy && comm != null && (
        <StrategyFull strategy={strategy} comm={comm} persona={persona ?? null} />
      )}
    </div>
  );
}

function AnalyzeDialog({
  contactId, contactName, businesses, onClose,
}: {
  contactId: string; contactName: string;
  businesses: { id: string; name: string }[];
  onClose: () => void;
}) {
  const [businessId, setBusinessId] = useState("");
  const [fullName, setFullName] = useState(contactName);
  const [employer, setEmployer] = useState("");
  const [location, setLocation] = useState("");
  const [urls, setUrls] = useState("");
  const [useCase, setUseCase] = useState("");
  const [stakes, setStakes] = useState("medium");
  const [error, setError] = useState("");

  const start = useMutation({
    mutationFn: async () =>
      await api("pipeline-start", {
        contact_id: contactId,
        business_id: businessId || null,
        channel: "email",
        overrides: {
          full_name: fullName,
          target_label: fullName,
          employer: employer ? [employer] : [],
          location: location ? [location] : [],
          profile_urls: urls.split(/\s+/).filter(Boolean),
          ...(useCase ? { use_case: useCase } : {}),
          stakes_level: stakes,
        },
      }),
    onSuccess: onClose,
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="fixed inset-0 bg-black/30 grid place-items-center z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 w-[480px] space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-semibold">Analyze {contactName}</h2>
        <p className="text-xs text-slate-500">
          Runs the full 3-stage pipeline (Perplexity public-web research → ChatGPT persona strategy →
          Claude communication strategy) once, then stores and reuses the result. Roughly $0.05–0.30.
          The more identifiers you give it, the stronger the identity match.
        </p>
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Full name"
          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
        <div className="grid grid-cols-2 gap-2">
          <input value={employer} onChange={(e) => setEmployer(e.target.value)} placeholder="Company (optional)"
            className="border border-slate-300 rounded-lg px-3 py-2 text-sm" />
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location (optional)"
            className="border border-slate-300 rounded-lg px-3 py-2 text-sm" />
        </div>
        <input value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="Profile URLs, space-separated (optional)"
          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
        <input value={useCase} onChange={(e) => setUseCase(e.target.value)} placeholder="What's this relationship about? (optional)"
          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
        <div className="grid grid-cols-2 gap-2">
          <select value={businessId} onChange={(e) => setBusinessId(e.target.value)}
            className="border border-slate-300 rounded-lg px-2 py-2 text-sm bg-white">
            <option value="">No specific business</option>
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <select value={stakes} onChange={(e) => setStakes(e.target.value)}
            className="border border-slate-300 rounded-lg px-2 py-2 text-sm bg-white">
            <option value="low">Low stakes</option>
            <option value="medium">Medium stakes</option>
            <option value="high">High stakes</option>
          </select>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-500">Cancel</button>
          <button onClick={() => start.mutate()} disabled={start.isPending}
            className="bg-indigo-600 text-white rounded-lg px-4 py-2 text-sm disabled:opacity-50">
            {start.isPending ? "Starting…" : "Run analysis"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-2 text-sm text-slate-700 space-y-1">{children}</div>
    </div>
  );
}

function StrategyFull({
  strategy, comm, persona,
}: {
  strategy: { allowed_zone: string; updated_at: string; re_analysis_recommended: boolean; re_analysis_reason: string };
  comm: Record<string, unknown>;
  persona: Record<string, unknown> | null;
}) {
  const blueprints = (comm.message_blueprints as Record<string, unknown>[]) ?? [];
  const sequencing = (comm.sequencing_plan as { step: number; goal: string; instruction: string }[]) ?? [];
  const interp = (comm.response_interpretation_rules as Record<string, string>[]) ?? [];
  const friction = (persona?.friction_risks as Record<string, unknown>[]) ?? [];
  const levers = (persona?.rapport_levers as Record<string, unknown>[]) ?? [];

  return (
    <div className="mt-6 space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">Stored strategy</h2>
        <span className={`text-xs px-2 py-0.5 rounded-full uppercase font-bold ${
          strategy.allowed_zone === "green" ? "bg-emerald-100 text-emerald-700"
          : strategy.allowed_zone === "yellow" ? "bg-amber-100 text-amber-700"
          : "bg-red-100 text-red-700"}`}>{strategy.allowed_zone}</span>
        <span className="text-xs text-slate-400">updated {fmtWhen(strategy.updated_at)}</span>
      </div>
      {strategy.re_analysis_recommended && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
          🔁 Re-analysis recommended — {strategy.re_analysis_reason}. Use the button above when ready
          (it never runs by itself).
        </div>
      )}
      <Section title="Objective & approach">
        <p><strong>Objective:</strong> {String(comm.message_objective ?? "")}</p>
        <p><strong>Approach:</strong> {String(comm.recommended_approach ?? "")}</p>
        <p className="text-xs text-slate-500"><strong>Safe next action:</strong> {String(comm.minimum_safe_next_action ?? "")}</p>
      </Section>
      {sequencing.length > 0 && (
        <Section title="Sequencing plan">
          <ol className="list-decimal ml-4 space-y-1">
            {sequencing.map((s) => <li key={s.step}><strong>{s.goal}:</strong> {s.instruction}</li>)}
          </ol>
        </Section>
      )}
      {blueprints.length > 0 && (
        <Section title="Message blueprints">
          {blueprints.map((b, i) => (
            <div key={i} className="border border-slate-100 rounded-lg p-2">
              <div className="text-xs font-semibold">{String(b.blueprint_name)} <span className="font-normal text-slate-400">— use when: {String(b.use_when)}</span></div>
              <pre className="mt-1 text-xs whitespace-pre-wrap font-sans text-slate-600">{String(b.template)}</pre>
            </div>
          ))}
        </Section>
      )}
      {friction.length > 0 && (
        <Section title="Friction risks (from persona stage)">
          <ul className="list-disc ml-4 text-xs space-y-1">
            {friction.slice(0, 5).map((f, i) => (
              <li key={i}><strong>{String(f.risk)}</strong> — mitigation: {((f.mitigation as string[]) ?? []).join("; ")}</li>
            ))}
          </ul>
        </Section>
      )}
      {levers.length > 0 && (
        <Section title="Rapport levers">
          <ul className="list-disc ml-4 text-xs space-y-1">
            {levers.slice(0, 5).map((l, i) => (
              <li key={i}><strong>{String(l.lever)}</strong> — {String(l.safe_usage_note)}</li>
            ))}
          </ul>
        </Section>
      )}
      {interp.length > 0 && (
        <Section title="How to read their responses">
          <ul className="list-disc ml-4 text-xs space-y-1">
            {interp.slice(0, 5).map((r, i) => (
              <li key={i}><strong>{r.observed_response_type}:</strong> {r.bounded_interpretation} → {r.recommended_next_step}</li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
