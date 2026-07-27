import { CSSProperties, FormEvent, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, supabase } from "../lib/supabase";
import { fmtWhen, useBusinesses, useProfile } from "../lib/hooks";
import type { GmailAccount } from "../lib/types";

const TABS = ["Account", "Connections", "API keys", "Businesses & rules", "Spend", "Digest", "System health"] as const;

export default function Settings() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Connections");
  return (
    <div className="max-w-3xl mx-auto p-8">
      <h1 className="text-2xl font-bold">Settings</h1>
      <div className="mt-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium ${
              tab === t ? "bg-indigo-600 text-white" : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-100"}`}>
            {t}
          </button>
        ))}
      </div>
      <div className="mt-6 space-y-4">
        {tab === "Account" && <Account />}
        {tab === "Connections" && <Connections />}
        {tab === "API keys" && <ApiKeys />}
        {tab === "Businesses & rules" && <Businesses />}
        {tab === "Spend" && <Spend />}
        {tab === "Digest" && <Digest />}
        {tab === "System health" && <Health />}
      </div>
    </div>
  );
}

function Card({ title, children, subtitle }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5">
      <h3 className="font-semibold">{title}</h3>
      {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
      <div className="mt-3">{children}</div>
    </div>
  );
}

// ------------------------------------------------------------- Account

function Account() {
  const { data: profile } = useProfile();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setMsg("");
    setErr("");
    if (pw.length < 10) { setErr("Use at least 10 characters."); return; }
    if (pw !== pw2) { setErr("The two passwords don't match."); return; }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) setErr(error.message);
    else { setMsg("Password updated — use it next time you sign in."); setPw(""); setPw2(""); }
    setBusy(false);
  }

  return (
    <>
      <Card title="Signed in as" subtitle={profile?.email ?? ""}>
        <p className="text-sm text-slate-600">
          Sign out any time from the sidebar. Only invited household accounts can log in.
        </p>
      </Card>
      <Card title="Change password" subtitle="Takes effect immediately; no email involved.">
        <form onSubmit={changePassword} className="space-y-3 max-w-sm">
          <input
            type="password" required placeholder="New password (10+ characters)" value={pw}
            autoComplete="new-password"
            onChange={(e) => setPw(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
          />
          <input
            type="password" required placeholder="Repeat new password" value={pw2}
            autoComplete="new-password"
            onChange={(e) => setPw2(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
          />
          {err && <p className="text-sm text-red-600">{err}</p>}
          {msg && <p className="text-sm text-emerald-600">{msg}</p>}
          <button
            disabled={busy}
            className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy ? "Saving…" : "Update password"}
          </button>
        </form>
      </Card>
      <Card
        title="Magic-link sign-in"
        subtitle="Passwordless login from the sign-in screen."
      >
        <p className="text-sm text-slate-600">
          The login page can email you a one-tap sign-in link instead of asking for a
          password. For the link to land back in this app, the Supabase project must have
          its <span className="font-medium">Site URL</span> set to this app's address
          (Dashboard → Authentication → URL Configuration), and custom SMTP configured
          for reliable delivery. One-time setup, done in the Supabase dashboard.
        </p>
      </Card>
    </>
  );
}

// ------------------------------------------------------------- Connections

function Connections() {
  const qc = useQueryClient();
  const [err, setErr] = useState("");
  const [oauthNotice, setOauthNotice] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gmail = params.get("gmail");
    if (gmail === "connected") {
      const email = params.get("email") ?? "";
      setOauthNotice({ kind: "ok", msg: `Connected${email ? `: ${email}` : ""}` });
    } else if (gmail === "error") {
      const msg = params.get("message") ?? "unknown error";
      setOauthNotice({ kind: "err", msg });
    }
    if (gmail) {
      const clean = new URL(window.location.href);
      clean.searchParams.delete("gmail");
      clean.searchParams.delete("email");
      clean.searchParams.delete("message");
      window.history.replaceState({}, "", clean.toString());
    }
  }, []);

  const { data: accounts = [] } = useQuery({
    queryKey: ["gmail-accounts"],
    queryFn: async (): Promise<GmailAccount[]> => {
      const { data, error } = await supabase.from("gmail_accounts").select("*").order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: cfg } = useQuery({
    queryKey: ["admin-config"],
    queryFn: async () => await api<Record<string, unknown>>("admin-config"),
  });

  const connect = useMutation({
    mutationFn: async () => await api<{ url: string }>("gmail-oauth-start", {}),
    onSuccess: (d) => { window.location.href = d.url; },
    onError: (e) => setErr((e as Error).message),
  });

  const setCfg = useMutation({
    mutationFn: async (args: { key: string; value: string }) => await api("admin-config", args),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-config"] }); setErr(""); },
    onError: (e) => setErr((e as Error).message),
  });

  const googleReady = Boolean(cfg?.google_client_id) && Boolean(cfg?.google_client_secret);

  return (
    <>
      <Card
        title="Google OAuth app (one-time household setup)"
        subtitle="From the Google Cloud runbook (docs/runbooks/google-cloud-setup.md). Both of you use the same client."
      >
        <ConfigInput label="Client ID" configKey="google_client_id"
          current={String(cfg?.google_client_id ?? "")} onSave={(v) => setCfg.mutate({ key: "google_client_id", value: v })} />
        <ConfigInput label="Client secret" configKey="google_client_secret" secret
          current={cfg?.google_client_secret ? "••••••••" : ""} onSave={(v) => setCfg.mutate({ key: "google_client_secret", value: v })} />
        <ConfigInput label="Pub/Sub topic (projects/…/topics/…) — enables instant push" configKey="pubsub_topic"
          current={String(cfg?.pubsub_topic ?? "")} onSave={(v) => setCfg.mutate({ key: "pubsub_topic", value: v })} />
        <p className="text-xs text-slate-400 mt-2">
          Without the Pub/Sub topic, mail still arrives via the 15-minute polling safety net. With it, it's seconds.
        </p>
      </Card>

      <Card title="Gmail accounts" subtitle="Connect every inbox you want in the queue. Read-only access — you keep replying from Gmail.">
        <ul className="space-y-2">
          {accounts.map((a) => (
            <li key={a.id} className="flex items-center gap-2 text-sm">
              <span className={`w-2 h-2 rounded-full ${a.status === "active" ? "bg-emerald-500" : a.status === "error" ? "bg-red-500" : "bg-amber-400"}`} />
              <span className="font-medium">{a.email_address}</span>
              <span className="text-xs text-slate-400">
                {a.status}{a.last_sync_at ? ` · synced ${fmtWhen(a.last_sync_at)}` : ""}
                {a.backfill_done ? "" : " · importing…"}
                {a.watch_expiration ? " · push ✓" : " · polling"}
              </span>
              {a.last_error && <span className="text-xs text-red-500 truncate">{a.last_error}</span>}
            </li>
          ))}
          {accounts.length === 0 && <li className="text-sm text-slate-400">No Gmail accounts connected yet.</li>}
        </ul>
        <button
          onClick={() => connect.mutate()}
          disabled={!googleReady || connect.isPending}
          className="mt-3 bg-indigo-600 text-white rounded-lg px-4 py-2 text-sm disabled:opacity-50"
        >
          {googleReady ? "Connect a Gmail account" : "Add the Google client above first"}
        </button>
      </Card>

      {oauthNotice && (
        <p className={`text-sm px-4 py-2 rounded-lg ${oauthNotice.kind === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
          {oauthNotice.kind === "ok" ? "✓ " : "✗ Gmail error: "}{oauthNotice.msg}
        </p>
      )}
      <Card
        title="Text & WhatsApp (dormant until you're ready)"
        subtitle="Fully built and waiting. When you've prepped your clients: add Twilio credentials under API keys, then search & buy your dedicated business number here."
      >
        <TwilioProvision onError={setErr} />
      </Card>
      {err && <p className="text-sm text-red-600">{err}</p>}
    </>
  );
}

function ConfigInput({ label, configKey, current, onSave, secret }: {
  label: string; configKey: string; current: string; onSave: (v: string) => void; secret?: boolean;
}) {
  const [val, setVal] = useState("");
  const [show, setShow] = useState(false);
  const [saved, setSaved] = useState(false);

  function handleSave() {
    if (!val.trim()) return;
    onSave(val.trim());
    setVal("");
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  return (
    <div className="mt-2">
      <label className="text-xs text-slate-500">{label}</label>
      <div className="flex gap-2 mt-1">
        <input
          type="text"
          placeholder={current || "not set"}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSave()}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-lpignore="true"
          data-form-type="other"
          style={secret && !show ? { WebkitTextSecurity: "disc" } as CSSProperties : undefined}
          className="flex-1 border border-slate-300 rounded-lg px-3 py-1.5 text-sm font-mono"
        />
        {secret && (
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="text-sm text-slate-500 px-2"
            title={show ? "Hide" : "Show"}
          >
            {show ? "Hide" : "Show"}
          </button>
        )}
        <button
          type="button"
          onClick={handleSave}
          disabled={!val.trim()}
          className="text-sm bg-slate-800 text-white rounded-lg px-3 disabled:opacity-40"
        >
          {saved ? "Saved ✓" : "Save"}
        </button>
      </div>
    </div>
  );
}

function TwilioProvision({ onError }: { onError: (s: string) => void }) {
  const [area, setArea] = useState("314");
  const [numbers, setNumbers] = useState<{ phone_number: string; friendly_name: string; locality: string }[]>([]);
  const { data: myNumbers = [] } = useQuery({
    queryKey: ["twilio-numbers"],
    queryFn: async () => {
      const { data } = await supabase.from("twilio_numbers").select("*");
      return data ?? [];
    },
  });
  const search = useMutation({
    mutationFn: async () => await api<{ numbers: typeof numbers }>("twilio-provision", { action: "search", area_code: area }),
    onSuccess: (d) => setNumbers(d.numbers),
    onError: (e) => onError((e as Error).message),
  });
  const buy = useMutation({
    mutationFn: async (phone: string) => await api("twilio-provision", { action: "purchase", phone_number: phone }),
    onSuccess: () => window.location.reload(),
    onError: (e) => onError((e as Error).message),
  });

  return (
    <div>
      {myNumbers.map((n: { id: string; phone_e164: string; status: string }) => (
        <div key={n.id} className="text-sm">📱 <strong>{n.phone_e164}</strong> · {n.status}</div>
      ))}
      <div className="flex gap-2 mt-2">
        <input value={area} onChange={(e) => setArea(e.target.value)} placeholder="Area code"
          className="w-24 border border-slate-300 rounded-lg px-3 py-1.5 text-sm" />
        <button onClick={() => search.mutate()} disabled={search.isPending}
          className="text-sm bg-slate-800 text-white rounded-lg px-3 py-1.5 disabled:opacity-50">
          {search.isPending ? "Searching…" : "Search numbers"}
        </button>
      </div>
      <ul className="mt-2 space-y-1">
        {numbers.map((n) => (
          <li key={n.phone_number} className="flex items-center gap-2 text-sm">
            <span className="flex-1">{n.friendly_name} {n.locality && `· ${n.locality}`}</span>
            <button onClick={() => buy.mutate(n.phone_number)} className="text-xs bg-indigo-600 text-white rounded px-2 py-1">
              Buy
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------- API keys

const KEY_KINDS = [
  { kind: "perplexity_api_key", label: "Perplexity API key", hint: "pipeline stage 1 — public-web research" },
  { kind: "openai_api_key", label: "OpenAI API key", hint: "pipeline stage 2 — persona strategy" },
  { kind: "anthropic_api_key", label: "Anthropic API key", hint: "pipeline stage 3, triage, drafts" },
  { kind: "twilio_account_sid", label: "Twilio Account SID", hint: "texting (when you go live)" },
  { kind: "twilio_auth_token", label: "Twilio Auth Token", hint: "texting (when you go live)" },
  { kind: "agentedge_service_key", label: "AgentEdge service role key", hint: "Contacts → Sync from AgentEdge CRM" },
];

function ApiKeys() {
  const qc = useQueryClient();
  const [err, setErr] = useState("");
  const { data: existing = [] } = useQuery({
    queryKey: ["user-secrets"],
    queryFn: async () => {
      const { data, error } = await supabase.from("user_secrets").select("kind,updated_at");
      if (error) throw error;
      return data ?? [];
    },
  });
  const save = useMutation({
    mutationFn: async (args: { kind: string; value: string }) => {
      const { error } = await supabase.rpc("set_user_secret", { p_kind: args.kind, p_value: args.value });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["user-secrets"] }); setErr(""); },
    onError: (e) => setErr((e as Error).message),
  });

  return (
    <Card
      title="Your API keys"
      subtitle="Each of you pays for and controls your own AI usage. Keys are stored encrypted in Supabase Vault and are never readable from the browser — only 'set' status is shown."
    >
      <div className="space-y-3">
        {KEY_KINDS.map((k) => {
          const set = existing.find((e) => e.kind === k.kind);
          return (
            <KeyRow key={k.kind} label={k.label} hint={k.hint}
              status={set ? `set ${fmtWhen(set.updated_at as string)}` : "not set"}
              onSave={(v) => save.mutate({ kind: k.kind, value: v })} />
          );
        })}
      </div>
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
    </Card>
  );
}

function KeyRow({ label, hint, status, onSave }: { label: string; hint: string; status: string; onSave: (v: string) => void }) {
  const [val, setVal] = useState("");
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-slate-400">{hint}</span>
        <span className={`ml-auto text-xs ${status === "not set" ? "text-slate-400" : "text-emerald-600"}`}>{status}</span>
      </div>
      <div className="flex gap-2 mt-1">
        <input type="password" value={val} onChange={(e) => setVal(e.target.value)} placeholder="Paste key"
          className="flex-1 border border-slate-300 rounded-lg px-3 py-1.5 text-sm" />
        <button onClick={() => { if (val.trim()) { onSave(val.trim()); setVal(""); } }}
          className="text-sm bg-slate-800 text-white rounded-lg px-3">Save</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------- Businesses & rules

function Businesses() {
  const qc = useQueryClient();
  const { data: businesses = [] } = useBusinesses();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#6366f1");
  const { data: rules = [] } = useQuery({
    queryKey: ["rules"],
    queryFn: async () => {
      const { data, error } = await supabase.from("triage_rules").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
  const addBusiness = useMutation({
    mutationFn: async () => {
      const { data: session } = await supabase.auth.getUser();
      const { error } = await supabase.from("businesses").insert({ name, color, user_id: session.user!.id });
      if (error) throw error;
    },
    onSuccess: () => { setName(""); qc.invalidateQueries({ queryKey: ["businesses"] }); },
  });
  const addRule = useMutation({
    mutationFn: async (r: Record<string, unknown>) => {
      const { data: session } = await supabase.auth.getUser();
      const { error } = await supabase.from("triage_rules").insert({ ...r, user_id: session.user!.id });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rules"] }),
  });
  const deleteRule = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("triage_rules").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rules"] }),
  });

  return (
    <>
      <Card title="Your businesses" subtitle="Messages get filed into these. Your account only — your husband sets up his own.">
        <ul className="space-y-1">
          {businesses.map((b) => (
            <li key={b.id} className="flex items-center gap-2 text-sm">
              <span className="w-3 h-3 rounded-full" style={{ backgroundColor: b.color }} />
              {b.name} {b.is_default && <span className="text-xs text-slate-400">(default bucket)</span>}
            </li>
          ))}
        </ul>
        <div className="flex gap-2 mt-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Business name"
            className="flex-1 border border-slate-300 rounded-lg px-3 py-1.5 text-sm" />
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="w-10 h-9 border border-slate-300 rounded-lg" />
          <button onClick={() => name.trim() && addBusiness.mutate()} className="text-sm bg-slate-800 text-white rounded-lg px-3">Add</button>
        </div>
      </Card>

      <Card title="Triage rules" subtitle="Deterministic and free — these run before any AI. Correct once, filed correctly forever.">
        <RuleForm businesses={businesses} onAdd={(r) => addRule.mutate(r)} />
        <ul className="mt-3 space-y-1 text-sm">
          {rules.map((r: Record<string, unknown>) => (
            <li key={String(r.id)} className="flex items-center gap-2">
              <span className="text-xs bg-slate-100 rounded px-1.5 py-0.5">{String(r.rule_type).replace("_", " ")}</span>
              <span className="font-mono text-xs">{String(r.pattern)}</span>
              <span className="text-xs text-slate-400">
                → {businesses.find((b) => b.id === r.business_id)?.name ?? ""} {String(r.category ?? "")} {String(r.action ?? "")}
                {r.source === "learned" ? " · learned" : ""}
              </span>
              <button onClick={() => deleteRule.mutate(String(r.id))} className="ml-auto text-xs text-red-500 hover:underline">delete</button>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function RuleForm({ businesses, onAdd }: { businesses: { id: string; name: string }[]; onAdd: (r: Record<string, unknown>) => void }) {
  const [ruleType, setRuleType] = useState("from_domain");
  const [pattern, setPattern] = useState("");
  const [businessId, setBusinessId] = useState("");
  const [category, setCategory] = useState("");
  const [action, setAction] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!pattern.trim()) return;
    onAdd({
      rule_type: ruleType,
      pattern: pattern.trim().toLowerCase(),
      business_id: businessId || null,
      category: category || null,
      action: action || null,
    });
    setPattern("");
  }
  return (
    <form onSubmit={submit} className="grid grid-cols-6 gap-2 text-sm">
      <select value={ruleType} onChange={(e) => setRuleType(e.target.value)} className="border border-slate-300 rounded-lg px-2 py-1.5 bg-white">
        <option value="from_email">from email</option>
        <option value="from_domain">from domain</option>
        <option value="to_email">to email</option>
        <option value="subject_contains">subject has</option>
      </select>
      <input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="pattern"
        className="col-span-2 border border-slate-300 rounded-lg px-2 py-1.5" />
      <select value={businessId} onChange={(e) => setBusinessId(e.target.value)} className="border border-slate-300 rounded-lg px-2 py-1.5 bg-white">
        <option value="">business…</option>
        {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
      <select value={category} onChange={(e) => setCategory(e.target.value)} className="border border-slate-300 rounded-lg px-2 py-1.5 bg-white">
        <option value="">category…</option>
        {["needs_reply", "fyi", "promotion", "expense", "receipt", "notification", "newsletter", "scheduling", "urgent", "other"].map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      <select value={action} onChange={(e) => setAction(e.target.value)} className="border border-slate-300 rounded-lg px-2 py-1.5 bg-white">
        <option value="">action…</option>
        <option value="needs_attention">needs attention</option>
        <option value="fyi">fyi</option>
        <option value="suppress">suppress</option>
      </select>
      <button className="col-span-6 bg-slate-800 text-white rounded-lg py-1.5">Add rule</button>
    </form>
  );
}

// ------------------------------------------------------------------ Spend

function Spend() {
  const { data } = useQuery({
    queryKey: ["spend"],
    queryFn: async () => {
      const { data: ledger, error } = await supabase
        .from("ai_spend_ledger")
        .select("purpose,cost_usd,occurred_at")
        .gte("occurred_at", new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString());
      if (error) throw error;
      const { data: caps } = await supabase.from("spend_caps").select("*").maybeSingle();
      return { ledger: ledger ?? [], caps };
    },
  });
  const byPurpose = new Map<string, number>();
  let total = 0;
  for (const row of data?.ledger ?? []) {
    byPurpose.set(row.purpose, (byPurpose.get(row.purpose) ?? 0) + Number(row.cost_usd));
    total += Number(row.cost_usd);
  }
  return (
    <Card title="AI spend this month" subtitle="Every model call is metered. Hard caps stop spend — nothing queues up.">
      <div className="text-3xl font-bold">${total.toFixed(2)}
        <span className="text-sm font-normal text-slate-400"> / ${Number(data?.caps?.monthly_cap_usd ?? 25)} cap</span>
      </div>
      <ul className="mt-3 space-y-1 text-sm">
        {[...byPurpose.entries()].sort((a, b) => b[1] - a[1]).map(([p, c]) => (
          <li key={p} className="flex justify-between">
            <span className="text-slate-600">{p.replaceAll("_", " ")}</span>
            <span className="font-mono">${c.toFixed(3)}</span>
          </li>
        ))}
        {byPurpose.size === 0 && <li className="text-slate-400">No AI spend yet this month.</li>}
      </ul>
      <p className="mt-3 text-xs text-slate-400">
        Caps: ${Number(data?.caps?.monthly_cap_usd ?? 25)}/mo total · ${Number(data?.caps?.pipeline_monthly_cap_usd ?? 15)}/mo pipeline ·{" "}
        {Number(data?.caps?.triage_daily_call_cap ?? 300)} triage calls/day
      </p>
    </Card>
  );
}

// ------------------------------------------------------------------ Digest

function Digest() {
  const qc = useQueryClient();
  const { data: profile } = useProfile();
  const save = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const { error } = await supabase.from("profiles").update(patch).eq("user_id", profile!.user_id);
      if (error) throw error;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["profile"] }),
  });
  if (!profile) return null;
  return (
    <>
      <Card title="Morning digest" subtitle="One email a day with what needs you — not constant pings. Timezone-aware for travel.">
        <div className="flex items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={profile.digest_enabled}
              onChange={(e) => save.mutate({ digest_enabled: e.target.checked })} />
            Enabled
          </label>
          <span>at</span>
          <select value={profile.digest_hour} onChange={(e) => save.mutate({ digest_hour: Number(e.target.value) })}
            className="border border-slate-300 rounded-lg px-2 py-1.5 bg-white">
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`}</option>
            ))}
          </select>
          <input
            defaultValue={profile.timezone}
            onBlur={(e) => e.target.value !== profile.timezone && save.mutate({ timezone: e.target.value })}
            className="border border-slate-300 rounded-lg px-2 py-1.5 flex-1"
            placeholder="America/Chicago"
          />
        </div>
      </Card>
      <ResendCard />
    </>
  );
}

function ResendCard() {
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const [from, setFrom] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const { data: cfg } = useQuery({
    queryKey: ["admin-config"],
    queryFn: async () => await api<Record<string, unknown>>("admin-config"),
  });
  const setCfg = useMutation({
    mutationFn: async (args: { key: string; value: string }) => await api("admin-config", args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-config"] });
      setErr(""); setMsg("Saved."); setKey("");
    },
    onError: (e) => { setMsg(""); setErr((e as Error).message); },
  });
  return (
    <Card
      title="Resend (email delivery)"
      subtitle="Powers the morning digest. Stored in Vault — never visible to the browser once saved."
    >
      <div className="space-y-3 max-w-lg text-sm">
        <div className="flex items-center gap-2">
          <input
            type="password" placeholder={cfg?.resend_api_key ? "Key is set — paste to replace" : "Resend API key (re_…)"}
            value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off"
            className="flex-1 border border-slate-300 rounded-lg px-3 py-2"
          />
          <button
            disabled={key.trim().length < 8}
            onClick={() => setCfg.mutate({ key: "resend_api_key", value: key.trim() })}
            className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-3 py-2 font-medium disabled:opacity-50"
          >
            Save key
          </button>
          <span className={`text-xs ${cfg?.resend_api_key ? "text-emerald-600" : "text-slate-400"}`}>
            {cfg?.resend_api_key ? "set" : "not set"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            placeholder={'From address, e.g. Command Center <digest@travelghr.com>'}
            defaultValue={(cfg?.digest_from_email as string) ?? ""}
            onChange={(e) => setFrom(e.target.value)}
            className="flex-1 border border-slate-300 rounded-lg px-3 py-2"
          />
          <button
            disabled={!from.trim()}
            onClick={() => setCfg.mutate({ key: "digest_from_email", value: from.trim() })}
            className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-3 py-2 font-medium disabled:opacity-50"
          >
            Save from
          </button>
        </div>
        <p className="text-xs text-slate-500">
          The From address must be on a domain verified in your Resend account. The same
          Resend key can also power login emails (magic links) — that part is pasted once
          into the Supabase dashboard's SMTP settings, not here.
        </p>
        {err && <p className="text-red-600">{err}</p>}
        {msg && <p className="text-emerald-600">{msg}</p>}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ Health

function Health() {
  const { data, error } = useQuery({
    queryKey: ["health"],
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_jobs_health");
      if (error) throw error;
      return data as {
        queues: { queue: string; length: number; oldest_msg_age_sec: number }[];
        dead_letters_7d: number;
        cron: { jobname: string; status: string; start_time: string }[];
      };
    },
  });
  return (
    <Card title="System health" subtitle="Everything runs in the cloud — check from anywhere. All zeros = healthy.">
      {error && <p className="text-sm text-red-600">{(error as Error).message}</p>}
      {data && (
        <>
          <table className="w-full text-sm">
            <tbody>
              {data.queues.map((q) => (
                <tr key={q.queue} className="border-b border-slate-100">
                  <td className="py-1.5">{q.queue}</td>
                  <td className={`text-right font-mono ${q.length > 20 ? "text-amber-600" : ""}`}>{q.length} queued</td>
                  <td className={`text-right font-mono text-xs ${q.oldest_msg_age_sec > 600 ? "text-red-600" : "text-slate-400"}`}>
                    oldest {q.oldest_msg_age_sec}s
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={`mt-2 text-sm ${data.dead_letters_7d > 0 ? "text-red-600" : "text-slate-500"}`}>
            Dead-lettered jobs (7d): {data.dead_letters_7d}
          </p>
          <div className="mt-2 text-xs text-slate-400 space-y-0.5">
            {data.cron.map((c) => (
              <div key={c.jobname}>{c.jobname}: {c.status} · {fmtWhen(c.start_time)}</div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
