import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  Eye,
  FileSearch,
  Focus,
  HandHelping,
  History,
  RotateCcw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  useMccToday,
  useObligationAction,
  useObligationEvents,
  useObligationSources,
} from "../lib/hooks";
import { MCC_POLICY } from "../lib/mccPolicy";
import type { MccTodayItem } from "../lib/types";

const SECTION_LABELS: Record<string, string> = {
  NEEDS_YOU_NOW: "Needs you now",
  NEXT: "Next",
  CHATGPT_CAN_HANDLE: "ChatGPT can handle",
  WAITING_ON_OTHERS: "Waiting on others",
  BLOCKED: "Blocked",
  SAFE_TO_DEFER: "Safe to defer",
};

const VERIFICATION_STYLE: Record<string, string> = {
  VERIFIED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  PARTIALLY_VERIFIED: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  UNVERIFIED: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  CONFLICT: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
  STALE: "bg-orange-50 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
};

function formatDateTime(value: string | null) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

type LastManualAction = {
  obligationId: string;
  title: string;
} | null;

export default function Executive() {
  const { data: items = [], isLoading, error } = useMccToday();
  const [focusMode, setFocusMode] = useState(false);
  const [lastAction, setLastAction] = useState<LastManualAction>(null);
  const undoAction = useObligationAction();

  const grouped = useMemo(() => {
    const result = new Map<string, MccTodayItem[]>();
    for (const item of items) {
      const list = result.get(item.section) ?? [];
      list.push(item);
      result.set(item.section, list);
    }
    return result;
  }, [items]);

  const focusItem = useMemo(
    () =>
      items.find(
        (item) =>
          item.section !== "WAITING_ON_OTHERS" &&
          item.section !== "BLOCKED" &&
          item.section !== "SAFE_TO_DEFER",
      ) ?? null,
    [items],
  );

  async function undoLastAction() {
    if (!lastAction) return;
    await undoAction.mutateAsync({
      id: lastAction.obligationId,
      action: { type: "UNDO" },
    });
    setLastAction(null);
  }

  if (isLoading) {
    return <div className="p-8 text-slate-500 dark:text-slate-400">Loading executive state…</div>;
  }

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-8">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <h1 className="text-2xl font-bold">Executive</h1>
          </div>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Verified executive state only. Communication queue and historical inbox noise stay separate.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setFocusMode((v) => !v)}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          <Focus className="w-4 h-4" />
          {focusMode ? "Show full view" : "Focus mode"}
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        <span className="px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
          {MCC_POLICY.executiveUiMode.replaceAll("_", " ").toLowerCase()}
        </span>
        <span className="px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          external communication: draft/manual approval only
        </span>
        <span className="px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          truth mode: fail closed
        </span>
      </div>

      {lastAction && (
        <div className="mt-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-200">
          <div>
            State updated for <span className="font-semibold">{lastAction.title}</span>. Audit history was preserved.
          </div>
          <button
            type="button"
            onClick={undoLastAction}
            disabled={undoAction.isPending}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-indigo-300 dark:border-indigo-800 px-3 py-1.5 font-medium disabled:opacity-50"
          >
            <RotateCcw className="w-4 h-4" />
            Undo
          </button>
        </div>
      )}

      {undoAction.error && (
        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          Undo failed. The latest state remains in place; inspect the history before trying another change.
        </div>
      )}

      {error ? (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          Executive state could not be loaded. Treat the dashboard as unavailable rather than assuming there is nothing to do.
        </div>
      ) : items.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-6">
          <div className="flex items-start gap-3">
            <FileSearch className="w-5 h-5 text-slate-400 mt-0.5" />
            <div>
              <h2 className="font-semibold">No active MCC obligations are currently surfaced</h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                This means the current deterministic view has no active item to show. It does not imply historical work was deleted.
              </p>
            </div>
          </div>
        </div>
      ) : focusMode ? (
        <div className="mt-6">
          {focusItem ? (
            <ExecutiveCard
              item={focusItem}
              prominent
              onActionCommitted={(action) => setLastAction(action)}
            />
          ) : (
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-5 text-sm text-slate-500 dark:text-slate-400">
              No currently actionable obligation. Waiting and blocked items remain visible in the full view.
            </div>
          )}
        </div>
      ) : (
        <div className="mt-8 space-y-8">
          {Array.from(grouped.entries()).map(([section, sectionItems]) => (
            <section key={section}>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {SECTION_LABELS[section] ?? section.replaceAll("_", " ")}
                </h2>
                <span className="text-xs text-slate-400">{sectionItems.length}</span>
              </div>
              <div className="space-y-3">
                {sectionItems.map((item) => (
                  <ExecutiveCard
                    key={item.obligation_id}
                    item={item}
                    onActionCommitted={(action) => setLastAction(action)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function ExecutiveCard({
  item,
  prominent = false,
  onActionCommitted,
}: {
  item: MccTodayItem;
  prominent?: boolean;
  onActionCommitted: (action: { obligationId: string; title: string }) => void;
}) {
  const [showEvidence, setShowEvidence] = useState(false);
  const [showBlocker, setShowBlocker] = useState(false);
  const [blockerReason, setBlockerReason] = useState("");
  const action = useObligationAction();
  const completionNeedsSourceResolution =
    item.verification_state === "CONFLICT" || item.type === "DISCREPANCY";

  async function commitAction(
    nextAction:
      | { type: "DONE" }
      | { type: "BLOCKED"; reason: string }
      | { type: "NEED_HELP" },
  ) {
    await action.mutateAsync({ id: item.obligation_id, action: nextAction });
    setShowBlocker(false);
    setBlockerReason("");
    onActionCommitted({ obligationId: item.obligation_id, title: item.title });
  }

  return (
    <article
      className={`rounded-2xl border bg-white dark:bg-slate-900 p-4 sm:p-5 ${
        prominent
          ? "border-indigo-300 dark:border-indigo-800 shadow-sm"
          : item.critical_attention
            ? "border-red-200 dark:border-red-900"
            : "border-slate-200 dark:border-slate-700"
      }`}
    >
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-slate-500 dark:text-slate-400">{item.type}</span>
            <span className={`px-2 py-0.5 rounded-full ${
              VERIFICATION_STYLE[item.verification_state] ?? VERIFICATION_STYLE.UNVERIFIED
            }`}>
              {item.verification_state.replaceAll("_", " ").toLowerCase()}
            </span>
            {item.risk_level !== "GREEN" && (
              <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
                <AlertTriangle className="w-3.5 h-3.5" /> {item.risk_level}
              </span>
            )}
          </div>
          <h3 className="mt-2 text-lg font-semibold">{item.title}</h3>
          {item.project_title && (
            <p className="text-sm text-slate-500 dark:text-slate-400">{item.project_title}</p>
          )}
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400 sm:text-right shrink-0">
          {item.due_at && (
            <div className="flex sm:justify-end items-center gap-1">
              <Clock3 className="w-3.5 h-3.5" />
              {formatDateTime(item.due_at)}
              {item.due_kind ? ` · ${item.due_kind.toLowerCase()}` : ""}
            </div>
          )}
          {item.execution_owner && <div className="mt-1">Owner: {item.execution_owner.replaceAll("_", " ")}</div>}
        </div>
      </div>

      {item.priority_reasons.length > 0 && (
        <div className="mt-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 px-3 py-2">
          <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">Why now</div>
          <div className="mt-1 text-sm">{item.priority_reasons.join(" · ")}</div>
        </div>
      )}

      <div className="mt-3 grid sm:grid-cols-2 gap-2 text-sm">
        <div>
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Next action</span>
          <div>{item.next_action || "Not yet defined"}</div>
        </div>
        <div>
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Freshness</span>
          <div>
            {item.freshness_expires_at
              ? item.is_stale
                ? `Stale since ${formatDateTime(item.freshness_expires_at)}`
                : `Valid until ${formatDateTime(item.freshness_expires_at)}`
              : "No expiry recorded"}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => commitAction({ type: "DONE" })}
          disabled={action.isPending || completionNeedsSourceResolution}
          title={completionNeedsSourceResolution ? "Resolve the source conflict/discrepancy before marking done." : "Mark done"}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <CheckCircle2 className="w-4 h-4" />
          Mark done
        </button>
        <button
          type="button"
          onClick={() => setShowBlocker((v) => !v)}
          disabled={action.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
        >
          <Ban className="w-4 h-4" />
          Block
        </button>
        <button
          type="button"
          onClick={() => commitAction({ type: "NEED_HELP" })}
          disabled={action.isPending || item.execution_owner === "CHATGPT_PREP"}
          className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-300 dark:border-indigo-800 px-3 py-2 text-sm font-medium text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950 disabled:opacity-50"
        >
          <HandHelping className="w-4 h-4" />
          Need help
        </button>
      </div>

      {completionNeedsSourceResolution && (
        <div className="mt-2 text-xs text-red-600 dark:text-red-400">
          Done is disabled while this item is a conflict/discrepancy. Resolve the authoritative source first.
        </div>
      )}

      {showBlocker && (
        <div className="mt-3 rounded-xl border border-slate-200 dark:border-slate-700 p-3">
          <label className="text-xs font-semibold text-slate-500 dark:text-slate-400">
            What is blocking this?
          </label>
          <textarea
            value={blockerReason}
            onChange={(e) => setBlockerReason(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
            placeholder="Name the blocker so it cannot disappear."
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => commitAction({ type: "BLOCKED", reason: blockerReason })}
              disabled={action.isPending || !blockerReason.trim()}
              className="rounded-lg bg-slate-900 dark:bg-slate-100 px-3 py-1.5 text-sm font-medium text-white dark:text-slate-900 disabled:opacity-40"
            >
              Save blocker
            </button>
            <button
              type="button"
              onClick={() => {
                setShowBlocker(false);
                setBlockerReason("");
              }}
              className="rounded-lg px-3 py-1.5 text-sm text-slate-500"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {action.error && (
        <div className="mt-3 rounded-lg bg-red-50 dark:bg-red-950 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          State change failed and was not treated as complete. Reload the current state before retrying.
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowEvidence((v) => !v)}
        className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
      >
        <Eye className="w-4 h-4" />
        {showEvidence ? "Hide evidence & history" : "Show evidence & history"}
        {showEvidence ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>

      {showEvidence && <EvidencePanel obligationId={item.obligation_id} />}
    </article>
  );
}

function EvidencePanel({ obligationId }: { obligationId: string }) {
  const { data: sources = [], isLoading: sourcesLoading, error: sourcesError } =
    useObligationSources(obligationId);
  const { data: events = [], isLoading: eventsLoading, error: eventsError } =
    useObligationEvents(obligationId);

  if (sourcesLoading || eventsLoading) {
    return <div className="mt-3 text-xs text-slate-400">Loading evidence and history…</div>;
  }

  return (
    <div className="mt-3 space-y-4">
      <div>
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">
          <ShieldCheck className="w-3.5 h-3.5" />
          Evidence
        </div>
        {sourcesError ? (
          <div className="mt-2 text-xs text-red-600 dark:text-red-400">
            Evidence could not be loaded. Do not treat the obligation as fully explained.
          </div>
        ) : sources.length === 0 ? (
          <div className="mt-2 rounded-lg bg-amber-50 dark:bg-amber-950 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            No source record is attached yet. This should remain unverified until provenance exists.
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            {sources.map((source) => (
              <div key={source.id} className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{source.source_system}</span>
                  <span className="text-slate-400">{source.evidence_role.toLowerCase()}</span>
                  {source.source_timestamp && <span className="text-slate-400">{formatDateTime(source.source_timestamp)}</span>}
                </div>
                <div className="mt-1 font-mono text-[11px] text-slate-500 break-all">{source.source_ref}</div>
                {source.claim_scope.length > 0 && (
                  <div className="mt-1 text-slate-500 dark:text-slate-400">
                    Claims: {source.claim_scope.join(", ")}
                  </div>
                )}
                {source.authoritative_claims.length > 0 && (
                  <div className="mt-1 inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Authoritative for: {source.authoritative_claims.join(", ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="mt-2 flex items-center gap-1 text-[11px] text-slate-400">
          <Sparkles className="w-3 h-3" /> Evidence display is descriptive; it does not upgrade verification automatically.
        </div>
      </div>

      <div>
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">
          <History className="w-3.5 h-3.5" />
          Recent state history
        </div>
        {eventsError ? (
          <div className="mt-2 text-xs text-red-600 dark:text-red-400">
            State history could not be loaded. Treat auditability as unavailable until it refreshes.
          </div>
        ) : events.length === 0 ? (
          <div className="mt-2 text-xs text-slate-400">No state events recorded yet.</div>
        ) : (
          <div className="mt-2 space-y-2">
            {events.map((event) => (
              <div key={event.id} className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{event.event_type.replaceAll("_", " ").toLowerCase()}</span>
                  <span className="text-slate-400">{event.actor_type.toLowerCase()}</span>
                  <span className="text-slate-400">{formatDateTime(event.created_at)}</span>
                </div>
                {event.reason && <div className="mt-1">{event.reason}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
