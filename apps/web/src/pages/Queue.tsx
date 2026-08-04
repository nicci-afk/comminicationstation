import { useState } from "react";
import { useBusinesses, useQueue } from "../lib/hooks";
import ItemCard from "../components/ItemCard";

const VIEWS: { key: string; label: string; states: string[] }[] = [
  { key: "attention", label: "Needs attention", states: ["needs_attention", "new"] },
  { key: "awaiting", label: "Awaiting their reply", states: ["awaiting_reply"] },
  { key: "snoozed", label: "Snoozed", states: ["snoozed"] },
  { key: "fyi", label: "FYI", states: ["fyi"] },
  { key: "done", label: "Done", states: ["responded", "dismissed"] },
];

export default function Queue() {
  const [view, setView] = useState(VIEWS[0]);
  const [businessId, setBusinessId] = useState<string | null>(null);
  const { data: businesses = [] } = useBusinesses();
  const { data: items = [], isLoading } = useQueue(view.states, businessId);

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-8">
      <h1 className="text-2xl font-bold">Queue</h1>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium ${
              view.key === v.key
                ? "bg-indigo-600 text-white"
                : "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            }`}
          >
            {v.label}
          </button>
        ))}
        <select
          value={businessId ?? ""}
          onChange={(e) => setBusinessId(e.target.value || null)}
          className="ml-auto border border-slate-300 dark:border-slate-600 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-slate-900 dark:text-slate-100"
        >
          <option value="">All businesses</option>
          {businesses.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
      </div>
      <div className="mt-4 space-y-2">
        {isLoading && <div className="text-slate-400 dark:text-slate-500">Loading…</div>}
        {!isLoading && items.length === 0 && <div className="text-slate-400 dark:text-slate-500 py-10 text-center">Nothing here.</div>}
        {items.map((item) => (
          <ItemCard key={item.id} item={item} businesses={businesses} />
        ))}
      </div>
    </div>
  );
}
