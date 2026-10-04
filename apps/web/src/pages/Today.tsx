// One queue page at a time. Counts describe the last verified queue read;
// handled counts describe only confirmed actions during this visit.
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { explicitFollowUpUtc, followUpLabel } from "../lib/queueFollowUp";
import { Check, ChevronDown, ChevronUp, Clock, ExternalLink, X } from "lucide-react";
import { TODAY_PAGE_SIZE, useBusinesses, useItemAction, useTodayQueue } from "../lib/hooks";
import type { QueueItem } from "../lib/types";
import ItemCard from "../components/ItemCard";

const expectedState = (item: QueueItem) => ({
  state: item.state, updated_at: item.updated_at,
  snoozed_until: item.snoozed_until, follow_up_at: item.follow_up_at,
  last_inbound_message_id: item.last_inbound_message_id, message_count: item.message_count,
});

export default function Today() {
  const [page, setPage] = useState(0);
  const queue = useTodayQueue(page);
  const { data: businesses = [], error: businessError } = useBusinesses();
  const action = useItemAction();
  const nav = useNavigate();
  const [cursor, setCursor] = useState(0);
  const [doneCount, setDoneCount] = useState(0);
  const [receipt, setReceipt] = useState<{ before: QueueItem; saved: QueueItem } | null>(null);
  const [message, setMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const [followUp, setFollowUp] = useState<{ item: QueueItem; value: string } | null>(null);
  const busy = useRef(false);
  const resolvedPage = queue.data?.page ?? page;
  const list = queue.data?.items ?? [];
  const index = Math.min(cursor, Math.max(0, list.length - 1));
  const current = list[index];
  const verified = !!queue.data && resolvedPage === page && !queue.error && !queue.isStale && !queue.isFetching && queue.fetchStatus !== "paused";
  const canAct = verified && !action.isPending;
  const total = queue.data?.total;

  // A shrinking queue can remove the final page. Re-read a valid page rather
  // than presenting an empty page as an empty queue.
  useEffect(() => {
    if (queue.data && !queue.error && !queue.isFetching && (resolvedPage !== page || (page > 0 && page * TODAY_PAGE_SIZE >= queue.data.total))) {
      setPage(Math.min(resolvedPage, Math.max(0, Math.ceil(queue.data.total / TODAY_PAGE_SIZE) - 1)));
      setCursor(0);
    }
  }, [queue.data, queue.error, queue.isFetching, page, resolvedPage]);

  async function handle(patch: Partial<QueueItem>, target = current) {
    if (!target || !canAct || busy.current) return;
    busy.current = true;
    setSaveError(""); setMessage("");
    try {
      const saved = await action.mutateAsync({ id: target.id, patch, expected: expectedState(target) });
      setReceipt({ before: target, saved });
      setFollowUp(null);
      setDoneCount(count => count + 1);
      setCursor(0);
    } catch {
      setSaveError("Change unconfirmed. Your handled count has not increased. Refresh the queue before trying again.");
    } finally { busy.current = false; }
  }

  async function undo() {
    if (!receipt || busy.current || !canAct) return;
    busy.current = true;
    setSaveError(""); setMessage("");
    try {
      const { before, saved } = receipt;
      await action.mutateAsync({ id: saved.id, expected: expectedState(saved), patch: {
        state: before.state, snoozed_until: before.snoozed_until, follow_up_at: before.follow_up_at,
      } });
      setReceipt(null); setDoneCount(count => Math.max(0, count - 1));
      setMessage("Last change undone.");
    } catch {
      setSaveError("Undo unconfirmed. The item may have changed. Refresh and open it to check its current state.");
    } finally { busy.current = false; }
  }

  async function scheduleFollowUp() {
    if (!followUp || busy.current || !canAct) return;
    const date = explicitFollowUpUtc(followUp.value);
    if (!date) { setSaveError("Choose an exact future follow-up date and time in UTC."); return; }
    // Use the row seen when the form was opened, not a newly selected card.
    await handle({ state: "awaiting_reply", follow_up_at: date, snoozed_until: null }, followUp.item);
  }

  function changeCursor(next: number) {
    if (busy.current) return;
    setFollowUp(null); setCursor(next);
  }

  function changePage(next: number) {
    if (busy.current) return;
    setFollowUp(null); setPage(next); setCursor(0);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey ||
        target?.closest("input, textarea, select, button, a, [contenteditable='true']")) return;
      if (busy.current || followUp) return;
      if (e.key === "j") setCursor(Math.min(index + 1, Math.max(0, list.length - 1)));
      if (e.key === "k") setCursor(Math.max(index - 1, 0));
      if (e.key === "Enter" && current) nav(`/item/${current.id}`);
      if (e.key === "d") void handle({ state: "dismissed" });
      if (e.key === "r") void handle({ state: "responded" });
      if (e.key === "s") void handle({ state: "snoozed", snoozed_until: new Date(Date.now() + 4 * 3600_000).toISOString() });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-8">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Today{verified ? `: ${total} need${total === 1 ? "s" : ""} attention` : ""}</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Work one at a time. Keyboard: <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>Enter</kbd> open ·{" "}
            <kbd>r</kbd> responded · <kbd>s</kbd> snooze · <kbd>d</kbd> dismiss
          </p>
        </div>
        <div className="shrink-0 text-sm text-slate-500 dark:text-slate-400" role="status">{doneCount} handled this visit</div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <button type="button" onClick={() => void queue.refetch()} disabled={queue.isFetching || action.isPending}
          className="underline disabled:opacity-50">Refresh queue</button>
        {queue.dataUpdatedAt > 0 && <span className="text-slate-500 dark:text-slate-400">Last checked {new Date(queue.dataUpdatedAt).toLocaleTimeString()}</span>}
      </div>
      {queue.error ? <p role="alert" className="mt-3 rounded-lg bg-amber-50 dark:bg-amber-950 p-3 text-sm">
        {queue.data ? "Queue refresh failed. Showing the last checked page; current count and state are unconfirmed." : "Queue unavailable. Its count and whether it is clear are unconfirmed."} Refresh to retry.
      </p> : queue.fetchStatus === "paused" ? <p role="status" className="mt-3 text-sm">Waiting for a connection. Queue state is unconfirmed.</p>
        : queue.isFetching ? <p role="status" className="mt-3 text-sm">{queue.data ? "Refreshing queue. Showing the last checked page…" : "Loading queue…"}</p>
        : queue.data && queue.isStale ? <p role="status" className="mt-3 text-sm">Queue may be out of date. Refresh before making changes.</p> : null}
      {businessError && <p role="alert" className="mt-3 text-sm">Business labels are unavailable; queue items are shown without verified labels.</p>}
      {action.isPending && <p role="status" className="mt-3 text-sm">Saving change…</p>}
      {saveError && <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">{saveError}</p>}
      {receipt && <div role="status" className="mt-3 rounded-lg bg-emerald-50 dark:bg-emerald-950 p-3 text-sm break-words">
        Saved: {receipt.before.title || "(no subject)"} · {receipt.saved.state === "snoozed" ? "snoozed for 4 hours" : receipt.saved.state === "awaiting_reply" ? "follow-up remains open" : receipt.saved.state}.
        {receipt.saved.state === "awaiting_reply" && <> {followUpLabel(receipt.saved.follow_up_at)}. <Link to="/queue?view=awaiting" className="underline">View open follow-ups</Link></>}
        {" "}<button type="button" onClick={event => { if (event.detail < 2) void undo(); }} disabled={!canAct} className="underline disabled:opacity-50">Undo last change</button>
      </div>}
      {message && <p role="status" className="mt-3 text-sm">{message}</p>}

      {verified && total === 0 ? (
        <div className="mt-12 text-center">
          <h2 className="text-xl font-semibold">Queue clear</h2>
          <p className="text-slate-500 dark:text-slate-400 mt-1">No items needed attention at the last check.</p>
          <Link to="/queue?view=awaiting" className="inline-block mt-3 text-sm underline">View scheduled follow-ups</Link>
        </div>
      ) : queue.data && <>
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
          {verified ? "Showing" : "Last checked page:"} {list.length ? `${resolvedPage * TODAY_PAGE_SIZE + 1}–${resolvedPage * TODAY_PAGE_SIZE + list.length}` : "0 items"} of {total} items needing attention
        </p>
        {current && <div className="mt-4 bg-white dark:bg-slate-900 border border-indigo-200 dark:border-indigo-800 rounded-2xl shadow-sm p-3 sm:p-6">
          <ItemCard item={current} businesses={businessError ? [] : businesses} selected />
          {current.priority_reasons?.length > 0 && <div className="mt-3 text-xs text-slate-500 dark:text-slate-400 break-words">Why it's here: {current.priority_reasons.join(" · ")}</div>}
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2" onClickCapture={event => {
            // A fast successful save may reveal the next item between the two
            // clicks of a double-click. Do not apply the second click to it.
            if (event.detail > 1) { event.preventDefault(); event.stopPropagation(); }
          }}>
            <button type="button" onClick={() => nav(`/item/${current.id}`)} disabled={action.isPending}
              className="flex items-center justify-center gap-1 bg-indigo-600 text-white rounded-xl py-3 text-sm font-medium disabled:opacity-50">
              <ExternalLink className="w-4 h-4" /> Open & reply
            </button>
            <button type="button" onClick={() => void handle({ state: "responded" })} disabled={!canAct || !!followUp}
              className="flex items-center justify-center gap-1 bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 rounded-xl py-3 text-sm font-medium disabled:opacity-50">
              <Check className="w-4 h-4" /> Responded
            </button>
            <button type="button" onClick={() => void handle({ state: "snoozed", snoozed_until: new Date(Date.now() + 4 * 3600_000).toISOString() })} disabled={!canAct || !!followUp}
              className="flex items-center justify-center gap-1 bg-sky-50 dark:bg-sky-950 text-sky-700 dark:text-sky-400 rounded-xl py-3 text-sm font-medium disabled:opacity-50">
              <Clock className="w-4 h-4" /> Snooze 4h
            </button>
            <button type="button" onClick={() => void handle({ state: "dismissed" })} disabled={!canAct || !!followUp}
              className="flex items-center justify-center gap-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl py-3 text-sm font-medium disabled:opacity-50">
              <X className="w-4 h-4" /> Dismiss
            </button>
          </div>
          <button type="button" onClick={() => { setSaveError(""); setFollowUp({ item: current, value: "" }); }} disabled={!canAct || !!followUp}
            className="mt-3 text-sm underline disabled:opacity-50">Set follow-up date</button>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Responded records a reply, not completion of the request. Conversational replies keep the existing four-day follow-up policy unless a date is already recorded.</p>
        </div>}
        {followUp && <form onSubmit={event => { event.preventDefault(); void scheduleFollowUp(); }} className="mt-4 rounded-xl border border-sky-300 p-4">
          <h2 className="font-medium">Follow up: {followUp.item.title || "(no subject)"}</h2>
          <p className="mt-1 text-sm">This is your next check-in, not a client deadline. No message is sent.</p>
          <label htmlFor="queue-follow-up" className="block mt-3 text-sm">Follow-up date and time (UTC)</label>
          <input id="queue-follow-up" type="datetime-local" required value={followUp.value}
            onChange={event => setFollowUp({ ...followUp, value: event.target.value })} disabled={action.isPending}
            className="mt-1 w-full rounded-lg border p-2 bg-white dark:bg-slate-900" />
          <div className="mt-3 flex gap-4">
            <button type="submit" disabled={!canAct || !followUp.value} className="underline disabled:opacity-50">Save follow-up</button>
            <button type="button" onClick={() => { setFollowUp(null); setSaveError(""); }} disabled={action.isPending} className="underline disabled:opacity-50">Cancel follow-up</button>
          </div>
        </form>}
        {list.length > 0 && <>
          <div className="mt-6 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <span>On this page</span>
            <button type="button" aria-label="Previous item" onClick={() => changeCursor(Math.max(index - 1, 0))} disabled={index === 0 || action.isPending} className="p-2 disabled:opacity-50"><ChevronUp className="w-4 h-4" /></button>
            <button type="button" aria-label="Next item" onClick={() => changeCursor(Math.min(index + 1, list.length - 1))} disabled={index >= list.length - 1 || action.isPending} className="p-2 disabled:opacity-50"><ChevronDown className="w-4 h-4" /></button>
          </div>
          <div className="mt-2 space-y-2 opacity-80">{list.map((item, i) => i === index ? null : <ItemCard key={item.id} item={item} businesses={businessError ? [] : businesses} />)}</div>
        </>}
      </>}
      {(page > 0 || (total ?? 0) > TODAY_PAGE_SIZE) && <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-sm">
          <button type="button" onClick={() => changePage(page - 1)} disabled={page === 0 || queue.isFetching || action.isPending} className="underline disabled:opacity-50">Previous page</button>
          <span>Page {resolvedPage + 1}{total !== undefined ? ` of ${Math.max(1, Math.ceil(total / TODAY_PAGE_SIZE))}` : ""}</span>
          <button type="button" onClick={() => changePage(page + 1)} disabled={(page + 1) * TODAY_PAGE_SIZE >= (total ?? 0) || !canAct} className="underline disabled:opacity-50">Next page</button>
        </div>}
    </div>
  );
}
