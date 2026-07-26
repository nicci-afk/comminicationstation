import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Star, Upload } from "lucide-react";
import { api, supabase } from "../lib/supabase";
import { fmtWhen } from "../lib/hooks";

interface ContactRow {
  id: string;
  display_name: string;
  kind: string;
  is_vip: boolean;
  last_seen_at: string;
  contact_strategies: { status: string; allowed_zone: string; re_analysis_recommended: boolean }[];
}

interface ImportResult {
  total: number;
  imported: number;
  updated: number;
  skipped: number;
  errors?: string[];
}

export default function Contacts() {
  const [search, setSearch] = useState("");
  const [humansOnly, setHumansOnly] = useState(true);
  const [importMsg, setImportMsg] = useState("");
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

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

  const { data: gmailAccounts = [] } = useQuery({
    queryKey: ["gmail-accounts-for-sync"],
    queryFn: async () => {
      const { data } = await supabase
        .from("gmail_accounts")
        .select("id,email_address,status")
        .order("email_address");
      return data ?? [];
    },
  });

  async function handleVcfFile(file: File) {
    setImportMsg("Reading file…");
    try {
      const vcf_content = await file.text();
      const result = await api<ImportResult>("contacts-vcf-import", { vcf_content });
      setImportMsg(
        `Done: ${result.imported} new, ${result.updated} updated, ${result.skipped} skipped` +
        (result.errors?.length ? ` · ${result.errors.length} error(s)` : "")
      );
      qc.invalidateQueries({ queryKey: ["contacts"] });
    } catch (e) {
      setImportMsg(`Error: ${(e as Error).message}`);
    }
  }

  async function handleGoogleSync(accountId: string) {
    setSyncingId(accountId);
    setImportMsg("");
    try {
      const result = await api<ImportResult>("contacts-google-sync", { gmail_account_id: accountId });
      setImportMsg(
        `Google sync done: ${result.imported} new, ${result.updated} updated, ${result.skipped} skipped` +
        (result.errors?.length ? ` · ${result.errors.length} error(s)` : "")
      );
      qc.invalidateQueries({ queryKey: ["contacts"] });
    } catch (e) {
      setImportMsg(`Sync error: ${(e as Error).message}`);
    }
    setSyncingId(null);
  }

  return (
    <div className="max-w-3xl mx-auto p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Contacts</h1>
        <div className="flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".vcf,text/vcard"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleVcfFile(f); e.target.value = ""; }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 text-sm border border-slate-300 rounded-lg px-3 py-1.5 bg-white hover:bg-slate-50"
          >
            <Upload className="w-4 h-4" /> Import vCard
          </button>
          {gmailAccounts.map((a: { id: string; email_address: string }) => (
            <button
              key={a.id}
              onClick={() => handleGoogleSync(a.id)}
              disabled={syncingId === a.id}
              className="flex items-center gap-1.5 text-sm border border-slate-300 rounded-lg px-3 py-1.5 bg-white hover:bg-slate-50 disabled:opacity-50"
              title={`Sync Google Contacts from ${a.email_address}`}
            >
              <RefreshCw className={`w-4 h-4 ${syncingId === a.id ? "animate-spin" : ""}`} />
              {syncingId === a.id ? "Syncing…" : `Sync ${a.email_address.split("@")[0]}`}
            </button>
          ))}
        </div>
      </div>

      {importMsg && (
        <div className="mt-3 text-sm px-3 py-2 rounded-lg bg-indigo-50 text-indigo-800">
          {importMsg}
          {importMsg.includes("Contacts access denied") && (
            <span className="block mt-1 text-xs">
              To fix: Settings → Gmail → Disconnect → Reconnect your account to grant Contacts access.
            </span>
          )}
        </div>
      )}

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
        {!isLoading && contacts.length === 0 && (
          <div className="p-4 text-slate-400 text-sm">No contacts yet — import a vCard or sync Google Contacts above.</div>
        )}
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
      <p className="mt-3 text-xs text-slate-400">
        Google Contacts sync requires reconnecting Gmail after granting Contacts access.
        Go to Settings → Gmail → Disconnect → Reconnect to enable it.
      </p>
    </div>
  );
}
