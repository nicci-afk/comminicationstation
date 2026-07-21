import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { supabase } from "../lib/supabase";
import { fmtWhen } from "../lib/hooks";

interface ContactRow {
  id: string;
  display_name: string;
  kind: string;
  is_vip: boolean;
  last_seen_at: string;
  contact_strategies: { status: string; allowed_zone: string; re_analysis_recommended: boolean }[];
}

export default function Contacts() {
  const [search, setSearch] = useState("");
  const [humansOnly, setHumansOnly] = useState(true);
  const { data: contacts = [], isLoading } = useQuery({
    queryKey: ["contacts", search, humansOnly],
    queryFn: async (): Promise<ContactRow[]> => {
      let q = supabase
        .from("contacts")
        .select("id,display_name,kind,is_vip,last_seen_at,contact_strategies(status,allowed_zone,re_analysis_recommended)")
        .is("merged_into_contact_id", null)
        .order("last_seen_at", { ascending: false })
        .limit(100);
      if (search) q = q.ilike("display_name", `%${search}%`);
      if (humansOnly) q = q.in("kind", ["human", "unknown"]);
      const { data, error } = await q;
      if (error) throw error;
      return (data as unknown as ContactRow[]) ?? [];
    },
  });

  return (
    <div className="max-w-3xl mx-auto p-8">
      <h1 className="text-2xl font-bold">Contacts</h1>
      <div className="mt-4 flex gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"
        />
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={humansOnly} onChange={(e) => setHumansOnly(e.target.checked)} />
          People only
        </label>
      </div>
      <div className="mt-4 divide-y divide-slate-100 bg-white border border-slate-200 rounded-xl">
        {isLoading && <div className="p-4 text-slate-400">Loading…</div>}
        {contacts.map((c) => {
          const s = c.contact_strategies?.[0];
          return (
            <Link key={c.id} to={`/contacts/${c.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50">
              {c.is_vip && <Star className="w-4 h-4 text-amber-500" fill="currentColor" />}
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{c.display_name}</div>
                <div className="text-xs text-slate-400">{c.kind} · seen {fmtWhen(c.last_seen_at)}</div>
              </div>
              {s ? (
                <span className={`text-xs px-2 py-1 rounded-full ${
                  s.allowed_zone === "green" ? "bg-emerald-100 text-emerald-700"
                  : s.allowed_zone === "yellow" ? "bg-amber-100 text-amber-700"
                  : "bg-red-100 text-red-700"}`}>
                  {s.re_analysis_recommended ? "🔁 re-analyze" : `strategy · ${s.allowed_zone}`}
                </span>
              ) : (
                <span className="text-xs text-slate-400">no strategy</span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
