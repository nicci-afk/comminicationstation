// Backlog Bankruptcy: the old-unread mountain lives here, NOT in the daily
// queue. Grouped by sender with batch actions that also teach triage rules.
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";

interface BacklogRow {
  id: string;
  sender_name: string;
  sender_identifier: string;
  title: string;
  category: string;
  created_at: string;
}

export default function Backlog() {
  const qc = useQueryClient();
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["backlog"],
    queryFn: async (): Promise<BacklogRow[]> => {
      const { data, error } = await supabase
        .from("queue_items")
        .select("id,sender_name,sender_identifier,title,category,created_at")
        .eq("state", "backlog")
        .order("created_at", { ascending: false })
        .limit(2000);
      if (error) throw error;
      return data ?? [];
    },
  });

  const groups = useMemo(() => {
    const map = new Map<string, { name: string; items: BacklogRow[] }>();
    for (const i of items) {
      const key = i.sender_identifier;
      if (!map.has(key)) map.set(key, { name: i.sender_name || key, items: [] });
      map.get(key)!.items.push(i);
    }
    return [...map.entries()]
      .map(([sender, g]) => ({ sender, ...g }))
      .sort((a, b) => b.items.length - a.items.length);
  }, [items]);

  const sweep = useMutation({
    mutationFn: async (args: { sender: string; mute: boolean }) => {
      const { error } = await supabase.rpc("backlog_sweep_sender", {
        p_sender: args.sender,
        p_mute: args.mute,
      });
      if (error) throw error;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["backlog"] }),
  });

  const promote = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("queue_items").update({ state: "needs_attention" }).eq("id", id);
      if (error) throw error;
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["backlog"] });
      qc.invalidateQueries({ queryKey: ["queue"] });
    },
  });

  return (
    <div className="max-w-3xl mx-auto p-8">
      <h1 className="text-2xl font-bold">Backlog</h1>
      <p className="text-sm text-slate-500 mt-1">
        Your pre-existing unread pile, kept out of the daily queue so Today starts clean. Clear it a
        sender at a time — “clear & mute” also teaches the triage rules so they never bother you again.
      </p>
      {isLoading && <div className="mt-6 text-slate-400">Loading…</div>}
      {!isLoading && items.length === 0 && (
        <div className="mt-12 text-center text-slate-400">
          <div className="text-4xl">🧹</div>
          <p className="mt-2">Backlog is empty. Freedom.</p>
        </div>
      )}
      <div className="mt-4 space-y-3">
        {groups.map((g) => (
          <div key={g.sender} className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{g.name}</div>
                <div className="text-xs text-slate-400 truncate">{g.sender} · {g.items.length} message{g.items.length === 1 ? "" : "s"}</div>
              </div>
              <button
                onClick={() => sweep.mutate({ sender: g.sender, mute: false })}
                className="text-xs bg-slate-100 hover:bg-slate-200 rounded-lg px-3 py-1.5"
              >
                Clear all
              </button>
              <button
                onClick={() => sweep.mutate({ sender: g.sender, mute: true })}
                className="text-xs bg-red-50 hover:bg-red-100 text-red-700 rounded-lg px-3 py-1.5"
              >
                Clear & mute sender
              </button>
            </div>
            <ul className="mt-2 space-y-1">
              {g.items.slice(0, 3).map((i) => (
                <li key={i.id} className="flex items-center gap-2 text-xs text-slate-500">
                  <Link to={`/item/${i.id}`} className="truncate hover:text-indigo-600 flex-1">{i.title || "(no subject)"}</Link>
                  <button onClick={() => promote.mutate(i.id)} className="text-indigo-600 hover:underline shrink-0">
                    needs attention →
                  </button>
                </li>
              ))}
              {g.items.length > 3 && <li className="text-xs text-slate-300">+ {g.items.length - 3} more</li>}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
