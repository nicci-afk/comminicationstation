import { AlertTriangle, CheckCircle2, LockKeyhole, ShieldAlert, ShieldCheck } from "lucide-react";
import { useMccIntegrityStatus, useProductionChangeReceipts } from "../lib/hooks";

function StateIcon({ state }: { state: string }) {
  if (state === "HEALTHY") return <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />;
  if (state === "FAILED") return <ShieldAlert className="w-5 h-5 text-red-600 dark:text-red-400" />;
  return <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />;
}

export default function TrustCenter() {
  const { data: status, isLoading, error } = useMccIntegrityStatus();
  const { data: receipts = [] } = useProductionChangeReceipts();

  if (isLoading) return <div className="p-8 text-slate-500 dark:text-slate-400">Checking system trust state…</div>;

  if (error || !status) {
    return (
      <div className="max-w-5xl mx-auto p-4 sm:p-8">
        <h1 className="text-2xl font-bold">Trust Center</h1>
        <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          Safety state could not be verified. Treat production automation as unavailable until this is resolved.
        </div>
      </div>
    );
  }

  const automations = [
    ["Database writes", status.automation_database_writes_enabled],
    ["External sends", status.automation_external_sends_enabled],
    ["Booking changes", status.automation_booking_changes_enabled],
    ["Financial actions", status.automation_financial_actions_enabled],
  ] as const;

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-8">
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
        <h1 className="text-2xl font-bold">Trust Center</h1>
      </div>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Deterministic safety state. If this page cannot verify a control, the safe assumption is that consequential automation should remain off.
      </p>

      <div className="mt-6 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
        <div className="flex items-center gap-3">
          <StateIcon state={status.integrity_state} />
          <div>
            <div className="font-semibold">Integrity: {status.integrity_state.replaceAll("_", " ")}</div>
            <div className="text-sm text-slate-500 dark:text-slate-400">
              {status.emergency_stop ? "Emergency stop is ON — automated consequential actions are fail-closed." : "Emergency stop is OFF."}
            </div>
          </div>
        </div>
        {status.emergency_stop_reason && (
          <div className="mt-3 text-sm rounded-lg bg-slate-50 dark:bg-slate-800 px-3 py-2">
            {status.emergency_stop_reason}
          </div>
        )}
      </div>

      <div className="mt-5 grid sm:grid-cols-2 gap-4">
        <section className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
          <h2 className="font-semibold">Automation guardrails</h2>
          <div className="mt-3 space-y-2">
            {automations.map(([label, enabled]) => (
              <div key={label} className="flex items-center justify-between text-sm">
                <span>{label}</span>
                <span className={enabled ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}>
                  {enabled ? "ENABLED" : "OFF"}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
          <h2 className="font-semibold">Integrity checks</h2>
          <div className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between"><span>Active obligations</span><span>{status.active_obligations}</span></div>
            <div className="flex justify-between"><span>Conflicts</span><span>{status.conflicts}</span></div>
            <div className="flex justify-between"><span>Stale items</span><span>{status.stale_items}</span></div>
            <div className="flex justify-between"><span>Missing provenance</span><span>{status.obligations_without_sources}</span></div>
            <div className="flex justify-between"><span>Duplicate source refs</span><span>{status.duplicate_source_refs}</span></div>
            <div className="flex justify-between"><span>Invalid state rows</span><span>{status.invalid_state_rows}</span></div>
          </div>
        </section>
      </div>

      <section className="mt-5 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
        <div className="flex items-center gap-2">
          <LockKeyhole className="w-4 h-4 text-slate-500" />
          <h2 className="font-semibold">Recent production change receipts</h2>
        </div>
        {receipts.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">No RED-action receipts recorded yet.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {receipts.slice(0, 10).map((r) => (
              <div key={r.id} className="rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-3 text-sm">
                <div className="font-medium">{r.requested_outcome}</div>
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {r.target_system} · {r.target_environment} · execution {r.execution_state.toLowerCase()} · verification {r.verification_state.toLowerCase()}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="mt-5 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-300">
        This page is intentionally read-only. Changing safety controls is a consequential production action and requires a controlled approval path.
      </div>
    </div>
  );
}
