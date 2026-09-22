// Focus Mode: a finite, completable daily list — one card at a time, big
// actions, a progress bar, keyboard-first. The endless queue lives elsewhere.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronDown, ChevronUp, Clock, ExternalLink, X } from "lucide-react";
import { useBusinesses, useItemAction, useQueue } from "../lib/hooks";
import ItemCard from "../components/ItemCard";

export default function Today() {
  const { data: items = [], isLoading } = useQueue(["needs_attention"]);
  const { data: businesses = [] } = useBusinesses();
  const action = useItemAction();
  const nav = useNavigate();
  const [cursor, setCursor] = useState(0);
  const [doneCount, setDoneCount] = useState(0);

  // Stable order: the list must never reshuffle underneath the user.
  const list = useMemo(() => items, [items]);
  const total = list.length + doneCount;
  const current = list[Math.min(cursor, Math.max(0, list.length - 1))];

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (e.key === "j") setCursor((c) => Math.min(c + 1, list.length - 1));
      if (e.key === "k") setCursor((c) => Math.max(c - 1, 0));
      if (e.key === "Enter" && current) nav(`/item/${current.id}`);
      if (e.key === "d" && current) dismiss(current.id);
      if (e.key === "r" && current) markResponded(current.id);
      if (e.key === "s" && current) snooze(current.id, 4);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function markResponded(id: string) {
    setDoneCount((d) => d + 1);
    action.mutate({ id, patch: { state: "responded" } });
  }
  function dismiss(id: string) {
    setDoneCount((d) => d + 1);
    action.mutate({ id, patch: { state: "dismissed" } });
  }
  function snooze(id: string, hours: number) {
    setDoneCount((d) => d + 1);
    action.mutate({
      id,
      patch: { state: "snoozed", snoozed_until: new Date(Date.now() + hours * 3600_000).toISOString() },
    });
  }

  if (isLoading) return <div className="p-10 text-slate-400 dark:text-slate-500">Loading your day…</div>;

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-8">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">
            Today: {list.length} need{list.length === 1 ? "s" : ""} you
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Work one at a time. Keyboard: <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>Enter</kbd> open ·{" "}
            <kbd>r</kbd> responded · <kbd>s</kbd> snooze · <kbd>d</kbd> dismiss
          </p>
        </div>
        {total > 0 && (
          <div className="text-right">
            <div className="text-sm text-slate-500 dark:text-slate-400">{doneCount} of {total} handled</div>
            <div className="w-40 h-2 bg-slate-200 dark:bg-slate-700 rounded-full mt-1">
              <div
                className="h-2 bg-indigo-500 rounded-full transition-all"
                style={{ width: `${total ? (doneCount / total) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {list.length === 0 ? (
        <div className="mt-16 text-center">
          <div className="text-5xl">🎉</div>
          <h2 className="text-xl font-semibold mt-3">Queue clear</h2>
          <p className="text-slate-500 dark:text-slate-400 mt-1">Nothing needs you right now. Anything new will appear here instantly.</p>
        </div>
      ) : (
        <>
          {current && (
            <div className="mt-6 bg-white dark:bg-slate-900 border border-indigo-200 dark:border-indigo-800 rounded-2xl shadow-sm p-6">
              <ItemCard item={current} businesses={businesses} selected />
              {current.priority_reasons?.length > 0 && (
                <div className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  Why it's here: {current.priority_reasons.join(" · ")}
                </div>
              )}
              <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
                <button onClick={() => nav(`/item/${current.id}`)}
                  className="flex items-center justify-center gap-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl py-3 text-sm font-medium">
                  <ExternalLink className="w-4 h-4" /> Open & reply
                </button>
                <button onClick={() => markResponded(current.id)}
                  className="flex items-center justify-center gap-1 bg-emerald-50 dark:bg-emerald-950 hover:bg-emerald-100 dark:hover:bg-emerald-900 text-emerald-700 dark:text-emerald-400 rounded-xl py-3 text-sm font-medium">
                  <Check className="w-4 h-4" /> Responded
                </button>
                <button onClick={() => snooze(current.id, 4)}
                  className="flex items-center justify-center gap-1 bg-sky-50 dark:bg-sky-950 hover:bg-sky-100 dark:hover:bg-sky-900 text-sky-700 dark:text-sky-400 rounded-xl py-3 text-sm font-medium">
                  <Clock className="w-4 h-4" /> Snooze 4h
                </button>
                <button onClick={() => dismiss(current.id)}
                  className="flex items-center justify-center gap-1 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-xl py-3 text-sm font-medium">
                  <X className="w-4 h-4" /> Dismiss
                </button>
              </div>
            </div>
          )}

          <div className="mt-6 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <span>Up next</span>
            <button onClick={() => setCursor((c) => Math.max(c - 1, 0))} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded">
              <ChevronUp className="w-4 h-4" />
            </button>
            <button onClick={() => setCursor((c) => Math.min(c + 1, list.length - 1))} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded">
              <ChevronDown className="w-4 h-4" />
            </button>
          </div>
          <div className="mt-2 space-y-2 opacity-80">
            {list.map((item, i) =>
              i === cursor ? null : <ItemCard key={item.id} item={item} businesses={businesses} />,
            )}
          </div>
        </>
      )}
    </div>
  );
}
