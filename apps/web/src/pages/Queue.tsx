import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { TODAY_PAGE_SIZE, useBusinesses, useQueue } from "../lib/hooks";
import ItemCard from "../components/ItemCard";

const VIEWS: { key: string; label: string; states: string[] }[] = [
  { key: "attention", label: "Needs attention", states: ["needs_attention", "new"] },
  { key: "awaiting", label: "Open follow-ups", states: ["awaiting_reply"] },
  { key: "snoozed", label: "Snoozed", states: ["snoozed"] },
  { key: "fyi", label: "FYI", states: ["fyi"] },
  { key: "done", label: "Replied / dismissed", states: ["responded", "dismissed"] },
];

export default function Queue() {
  const [params, setParams] = useSearchParams();
  const view = VIEWS.find(candidate => candidate.key === params.get("view")) ?? VIEWS[0];
  const requestedPage = Number(params.get("page") ?? "0");
  const page = Number.isSafeInteger(requestedPage) && requestedPage >= 0 ? requestedPage : 0;
  const setView = (next: typeof view) => setParams({ view: next.key });
  const setPage = (next: number) => setParams({ view: view.key, page: String(next) });
  const [businessId, setBusinessId] = useState<string | null>(null);
  const { data: businesses = [], error: businessError } = useBusinesses();
  const queue = useQueue(view.states, businessId, page);
  const items = queue.data?.items ?? [];
  const resolvedPage = queue.data?.page ?? page;
  const total = queue.data?.total;
  const verified = !!queue.data && !queue.error && !queue.isFetching && !queue.isStale && queue.fetchStatus !== "paused" && resolvedPage === page;
  useEffect(() => {
    if (queue.data && !queue.error && !queue.isFetching && resolvedPage !== page) {
      setParams({ view: view.key, page: String(resolvedPage) }, { replace: true });
    }
  }, [queue.data, queue.error, queue.isFetching, resolvedPage, page, view.key, setParams]);

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-8">
      <h1 className="text-2xl font-bold">Queue</h1>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Reply status and request completion are separate. A reply does not complete an Executive obligation.</p>
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
          onChange={(e) => { setBusinessId(e.target.value || null); setPage(0); }}
          className="ml-auto border border-slate-300 dark:border-slate-600 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-slate-900 dark:text-slate-100"
        >
          <option value="">All businesses</option>
          {businesses.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <button type="button" onClick={() => void queue.refetch()} disabled={queue.isFetching} className="underline disabled:opacity-50">Refresh queue</button>
        {queue.data && <span>{verified ? "Showing" : "Last checked page:"} {items.length ? `${resolvedPage * TODAY_PAGE_SIZE + 1}–${resolvedPage * TODAY_PAGE_SIZE + items.length}` : "0 items"} of {total}</span>}
      </div>
      {queue.error ? <p role="alert" className="mt-3 text-sm">{queue.data ? "Queue refresh failed. Showing the last checked page; current status is unconfirmed." : "Queue unavailable. Whether this list is empty is unconfirmed."} Refresh to retry.</p>
        : queue.fetchStatus === "paused" ? <p role="status" className="mt-3 text-sm">Waiting for a connection. Queue state is unconfirmed.</p>
        : queue.isFetching ? <p role="status" className="mt-3 text-sm">{queue.data ? "Refreshing queue…" : "Loading…"}</p>
        : queue.data && queue.isStale ? <p role="status" className="mt-3 text-sm">Queue may be out of date. Refresh to verify it.</p> : null}
      {businessError && <p role="alert" className="mt-3 text-sm">Business labels are unavailable.</p>}
      <div className="mt-4 space-y-2">
        {verified && total === 0 && <div className="text-slate-400 dark:text-slate-500 py-10 text-center">No items in this view at the last check.</div>}
        {items.map((item) => <ItemCard key={item.id} item={item} businesses={businessError ? [] : businesses} />)}
      </div>
      {(page > 0 || (total ?? 0) > TODAY_PAGE_SIZE) && <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-sm">
        <button type="button" onClick={() => setPage(page - 1)} disabled={page === 0 || queue.isFetching} className="underline disabled:opacity-50">Previous page</button>
        <span>Page {resolvedPage + 1}{total !== undefined ? ` of ${Math.max(1, Math.ceil(total / TODAY_PAGE_SIZE))}` : ""}</span>
        <button type="button" onClick={() => setPage(page + 1)} disabled={!verified || (page + 1) * TODAY_PAGE_SIZE >= (total ?? 0)} className="underline disabled:opacity-50">Next page</button>
      </div>}
    </div>
  );
}
