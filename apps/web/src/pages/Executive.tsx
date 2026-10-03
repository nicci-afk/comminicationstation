import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Clock3,
  Eye,
  FileSearch,
  Focus,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useMccObligationAction, useMccToday, useObligationEvents, useObligationSources } from "../lib/hooks";
import { MCC_POLICY } from "../lib/mccPolicy";
import FastCapture from "../components/FastCapture";
import { dailyItems, selectFocus } from "../lib/mccWorkflow";
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

export default function Executive() {
  const { data: items = [], isLoading, error } = useMccToday();
  const [focusMode, setFocusMode] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [receipt, setReceipt] = useState<{ id: string; title: string } | null>(null);
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [undoMessage, setUndoMessage] = useState("");
  const undo = useMccObligationAction();
  async function undoRecent() {
    if (!receipt) return;
    try {
      await undo.mutateAsync({ obligation_id: receipt.id, action: "UNDO_LAST" });
      setReceipt(null); setRevealedId(null); setUndoMessage("Last change undone.");
    } catch (e) { setUndoMessage(e instanceof Error ? e.message : "Undo unconfirmed."); }
  }
  function saved(item: MccTodayItem) { setReceipt({ id: item.obligation_id, title: item.title }); setUndoMessage(""); }
  function reviewed(item: { id: string; title: string }) { setReceipt(item); setUndoMessage(""); }
  const revealedItem = items.find(item => item.obligation_id === revealedId);

  const grouped = useMemo(() => {
    const result = new Map<string, MccTodayItem[]>();
    for (const item of dailyItems(items, expanded)) {
      const list = result.get(item.section) ?? [];
      list.push(item);
      result.set(item.section, list);
    }
    return result;
  }, [items, expanded]);

  const focusItem = selectFocus(items);

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
            Your next actions, captures, and follow-ups in one place.
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

      <FastCapture onReviewed={reviewed} />
      <p className="mt-4 text-sm text-slate-500">Start with urgent exceptions, focus on one action, then check waiting follow-ups before finishing your day.</p>
      {receipt && <div role="status" className="mt-3 rounded-lg bg-emerald-50 dark:bg-emerald-950 p-3 text-sm">
        Saved: {receipt.title}. {items.some(item => item.obligation_id === receipt.id) && <button type="button" onClick={() => { setFocusMode(false); setRevealedId(receipt.id); }} className="mr-3 underline">View action</button>}
        <button type="button" onClick={undoRecent} disabled={undo.isPending} className="underline">Undo last change</button>
      </div>}
      {undoMessage && <p role="status" className="text-sm">{undoMessage}</p>}
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

      {error ? (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          Executive state could not be loaded. Treat the dashboard as unavailable rather than assuming there is nothing to do.
        </div>
      ) : items.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-6">
          <div className="flex items-start gap-3">
            <FileSearch className="w-5 h-5 text-slate-400 mt-0.5" />
            <div>
              <h2 className="font-semibold">No active MCC obligations are visible</h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                This is intentionally different from “everything is done.” If you expected active work here, treat this as a state to verify rather than proof that nothing is outstanding.
              </p>
            </div>
          </div>
        </div>
      ) : focusMode ? (
        <div className="mt-6">
          {focusItem ? (
            <ExecutiveCard key={focusItem.obligation_id} item={focusItem} prominent onSaved={saved} />
          ) : (
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-5 text-sm text-slate-500 dark:text-slate-400">
              No eligible action for you right now. Review waiting items, blockers, captures, and verification exceptions in the full view.
            </div>
          )}
        </div>
      ) : (
        <div className="mt-8 space-y-8">
          {revealedItem && <section aria-label="Saved action" className="rounded-xl border border-indigo-200 dark:border-indigo-800 p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="font-semibold">Saved action</h2>
              <button type="button" onClick={() => { setRevealedId(null); setExpanded(false); }} className="text-sm underline">Back to daily summary</button>
            </div>
            <ExecutiveCard key={revealedItem.obligation_id} item={revealedItem} onSaved={saved} />
          </section>}
          <button type="button" onClick={() => setExpanded(v => !v)} className="text-sm underline">{expanded ? "Show daily summary" : "Show all active obligations"}</button>
          {Array.from(grouped.entries()).map(([section, sectionItems]) => {
            const visibleItems = sectionItems.filter(item => item.obligation_id !== revealedItem?.obligation_id);
            const total = items.filter(item => item.section === section).length;
            if (visibleItems.length === 0) return null;
            return (
            <section key={section}>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {SECTION_LABELS[section] ?? section.replaceAll("_", " ")}
                </h2>
                <span className="text-xs text-slate-400">{visibleItems.length < total ? `${visibleItems.length} of ${total}` : total}</span>
              </div>
              <div className="space-y-3">
                {visibleItems.map((item) => (
                  <ExecutiveCard key={item.obligation_id} item={item} onSaved={saved} />
                ))}
              </div>
            </section>
          ); })}
        </div>
      )}
    </div>
  );
}

function ExecutiveCard({ item, prominent = false, onSaved }: { item: MccTodayItem; prominent?: boolean; onSaved: (item: MccTodayItem) => void }) {
  const [form, setForm] = useState<"BLOCKED" | "WAITING" | null>(null);
  const [reason, setReason] = useState("");
  const [waitingOn, setWaitingOn] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [showEvidence, setShowEvidence] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const action = useMccObligationAction();

  async function runAction(kind: "DONE" | "BLOCKED" | "WAITING" | "NEED_HELP" | "UNDO_LAST") {
    setActionMessage(null);
    try {
      if (kind === "DONE") {
        await action.mutateAsync({ obligation_id: item.obligation_id, action: "DONE" });
      } else if (kind === "BLOCKED") {
        if (!reason.trim()) { setActionMessage("A blocker is required."); return; }
        await action.mutateAsync({ obligation_id: item.obligation_id, action: "BLOCKED", reason: reason.trim() });
      } else if (kind === "WAITING") {
        if (!waitingOn.trim()) { setActionMessage("Who or what are you waiting on?"); return; }
        const parsed = followUp ? new Date(followUp) : null;
        if (parsed && Number.isNaN(parsed.getTime())) { setActionMessage("Invalid follow-up time. Nothing changed."); return; }
        await action.mutateAsync({ obligation_id: item.obligation_id, action: "WAITING", waiting_on: waitingOn.trim(), follow_up_at: parsed?.toISOString() ?? null });
      } else {
        await action.mutateAsync({ obligation_id: item.obligation_id, action: kind });
      }
      setForm(null);
      if (kind !== "UNDO_LAST") onSaved(item);
      setActionMessage(kind === "UNDO_LAST" ? "Last manual change undone." : "Change saved and audited.");
    } catch (e) {
      setActionMessage(e instanceof Error ? e.message : "Change failed. Nothing should be assumed updated.");
    }
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
        <button type="button" disabled={action.isPending} onClick={() => runAction("DONE")}
          className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
          Done
        </button>
        {!prominent && <button type="button" disabled={action.isPending} onClick={() => setForm("WAITING")}
          className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2 text-sm font-medium disabled:opacity-50">
          Waiting
        </button>}
        <button type="button" disabled={action.isPending} onClick={() => setForm("BLOCKED")}
          className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2 text-sm font-medium disabled:opacity-50">
          Blocked
        </button>
        <button type="button" disabled={action.isPending} onClick={() => runAction("NEED_HELP")}
          className="rounded-lg border border-indigo-300 dark:border-indigo-800 px-3 py-2 text-sm font-medium text-indigo-700 dark:text-indigo-300 disabled:opacity-50">
          Need help
        </button>
        {!prominent && <button type="button" disabled={action.isPending} onClick={() => runAction("UNDO_LAST")}
          className="rounded-lg px-3 py-2 text-sm font-medium text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50">
          Undo last change
        </button>}
      </div>

      {form && <form className="mt-3 space-y-2" onSubmit={e => { e.preventDefault(); void runAction(form); }}>
        {form === "BLOCKED" ? <label className="block text-sm">What is blocking this?
          <input autoFocus required value={reason} maxLength={2000} onChange={e => setReason(e.target.value)} className="mt-1 block w-full rounded-lg border bg-transparent p-2" />
        </label> : <>
          <label className="block text-sm">Who or what are you waiting on?
            <input autoFocus required value={waitingOn} maxLength={500} onChange={e => setWaitingOn(e.target.value)} className="mt-1 block w-full rounded-lg border bg-transparent p-2" />
          </label>
          <label className="block text-sm">Follow-up (optional, your device's local time)
            <input type="datetime-local" value={followUp} onChange={e => setFollowUp(e.target.value)} className="mt-1 rounded-lg border bg-transparent p-2" />
          </label>
        </>}
        <button disabled={action.isPending} type="submit" className="rounded-lg bg-indigo-600 px-3 py-2 text-white text-sm">Save</button>
        <button disabled={action.isPending} type="button" onClick={() => setForm(null)} className="ml-2 text-sm underline">Cancel</button>
      </form>}
      <p className="mt-2 text-xs text-slate-500">Status: {item.state.replaceAll("_", " ").toLowerCase()}{item.waiting_on ? ` · Waiting on: ${item.waiting_on}` : ""}{item.follow_up_at ? ` · Follow-up: ${formatDateTime(item.follow_up_at)}` : ""}</p>
      {actionMessage && (
        <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">{actionMessage}</div>
      )}

      <button
        type="button"
        onClick={() => setShowEvidence((v) => !v)}
        className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
      >
        <Eye className="w-4 h-4" />
        {showEvidence ? "Hide evidence" : "Show evidence"}
        {showEvidence ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>

      {showEvidence && <EvidencePanel obligationId={item.obligation_id} />}
    </article>
  );
}

function EvidencePanel({ obligationId }: { obligationId: string }) {
  const { data: sources = [], isLoading, error } = useObligationSources(obligationId);
  const { data: events = [], error: eventsError } = useObligationEvents(obligationId);

  if (isLoading) return <div className="mt-3 text-xs text-slate-400">Loading evidence…</div>;
  if (error) {
    return (
      <div className="mt-3 text-xs text-red-600 dark:text-red-400">
        Evidence could not be loaded. Do not treat the obligation as fully explained.
      </div>
    );
  }
  if (sources.length === 0) {
    return (
      <div className="mt-3 rounded-lg bg-amber-50 dark:bg-amber-950 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
        No source record is attached yet. This should remain unverified until provenance exists.
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2">
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
      <div className="flex items-center gap-1 text-[11px] text-slate-400">
        <Sparkles className="w-3 h-3" /> Evidence display is descriptive; it does not upgrade verification automatically.
      </div>
      {eventsError && <p role="alert" className="text-xs text-red-600">History unavailable. Do not assume there were no changes.</p>}
      {events.length > 0 && (
        <div className="pt-2">
          <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">Recent history</div>
          <div className="mt-2 space-y-1.5">
            {events.slice(0, 8).map((event) => (
              <div key={event.id} className="rounded-lg bg-slate-50 dark:bg-slate-800/60 px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{event.event_type.replaceAll("_", " ").toLowerCase()}</span>
                  <span className="text-slate-400">{formatDateTime(event.created_at)}</span>
                </div>
                {event.reason && <div className="mt-1 text-slate-500 dark:text-slate-400">{event.reason}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
