// One attention episode: the conversation, the trust ledger (why it's here,
// every automated transition with evidence), the stored strategy, drafting,
// and the resolution actions.
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban, Check, Clock, Send, Sparkles, UserPlus, X } from "lucide-react";
import { api, supabase } from "../lib/supabase";

const CATEGORIES: [string, string][] = [
  ["booking", "Booking (travel)"],
  ["bdm", "BDM (travel rep)"],
  ["possible_supplier", "Possible supplier"],
  ["lead", "Lead (real estate)"],
  ["agent_to_agent", "Agent to agent"],
  ["lender", "Lender"],
  ["title", "Title company"],
  ["needs_reply", "Needs reply"],
  ["scheduling", "Scheduling"],
  ["urgent", "Urgent"],
  ["receipt", "Receipt"],
  ["expense", "Expense"],
  ["fyi", "FYI"],
  ["promotion", "Promotion"],
  ["newsletter", "Newsletter"],
  ["notification", "Notification"],
  ["other", "Other"],
];
import {
  fmtWhen, useArtifactOutput, useBusinesses, useContact, useItemAction, useItemEvents,
  useStrategies, useThreadMessages,
} from "../lib/hooks";
import type { Message, QueueItem } from "../lib/types";
import { BusinessChip } from "../components/ItemCard";
import StrategyPanel from "../components/StrategyPanel";

export default function ItemDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const action = useItemAction();
  const [draft, setDraft] = useState<{ text: string; notes: string } | null>(null);
  const [smsText, setSmsText] = useState("");
  const [error, setError] = useState("");
  const [blockStatus, setBlockStatus] = useState<"" | "confirming" | "blocking" | "done">("");
  const [linkSearch, setLinkSearch] = useState("");
  const [linkResults, setLinkResults] = useState<{ id: string; display_name: string; kind: string }[]>([]);
  const [linkSelected, setLinkSelected] = useState<{ id: string; display_name: string } | null>(null);
  const [linkStatus, setLinkStatus] = useState<"" | "saving" | "saved">("");
  const [recatCategory, setRecatCategory] = useState("");
  const [recatBusiness, setRecatBusiness] = useState<string | null>(null);
  const [recatBusinesses, setRecatBusinesses] = useState<string[]>([]);
  const [recatInit, setRecatInit] = useState(false);
  const [recatStatus, setRecatStatus] = useState<"" | "saving" | "saved">("");

  const { data: item } = useQuery({
    queryKey: ["item", id],
    queryFn: async (): Promise<QueueItem | null> => {
      const { data, error } = await supabase.from("queue_items").select("*").eq("id", id!).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const { data: messages = [] } = useThreadMessages(item?.thread_id ?? null);
  const { data: events = [] } = useItemEvents(id ?? null);
  const { data: contact } = useContact(item?.contact_id ?? null);
  const { data: strategies = [] } = useStrategies(item?.contact_id ?? null);
  const { data: businesses = [] } = useBusinesses();
  const strategy = strategies.find((s) => s.business_id === item?.business_id) ?? strategies[0] ?? null;
  const { data: comm } = useArtifactOutput(strategy?.comm_artifact_id ?? null);

  const draftMutation = useMutation({
    mutationFn: async () => await api<{ draft: string; notes: string }>("draft-reply", { queue_item_id: id }),
    onSuccess: (d) => { setDraft({ text: d.draft, notes: d.notes }); setError(""); },
    onError: (e) => setError((e as Error).message),
  });

  const sendSms = useMutation({
    mutationFn: async () =>
      await api("twilio-send", { thread_id: item!.thread_id, body: smsText }),
    onSuccess: () => {
      setSmsText("");
      qc.invalidateQueries({ queryKey: ["messages"] });
      qc.invalidateQueries({ queryKey: ["queue"] });
      setError("");
    },
    onError: (e) => setError((e as Error).message),
  });

  const blockSender = useMutation({
    mutationFn: async () => await api("spam-block", { queue_item_id: id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["queue"] });
      nav(-1);
    },
    onError: (e) => { setError((e as Error).message); setBlockStatus(""); },
  });

  const logOutcome = useMutation({
    mutationFn: async () =>
      await api("interaction-update", { mode: "auto", strategy_id: strategy!.id, queue_item_id: id }),
    onError: (e) => setError((e as Error).message),
  });

  useEffect(() => {
    if (!linkSearch.trim()) { setLinkResults([]); return; }
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from("contacts")
        .select("id, display_name, kind")
        .ilike("display_name", `%${linkSearch}%`)
        .is("merged_into_contact_id", null)
        .limit(6);
      setLinkResults((data as { id: string; display_name: string; kind: string }[]) ?? []);
    }, 250);
    return () => clearTimeout(t);
  }, [linkSearch]);

  const linkSender = useMutation({
    mutationFn: async () => await api("contact-link", { queue_item_id: id, contact_id: linkSelected!.id }),
    onSuccess: () => {
      setLinkStatus("saved");
      setLinkSearch("");
      setLinkSelected(null);
      qc.invalidateQueries({ queryKey: ["item", id] });
      qc.invalidateQueries({ queryKey: ["queue"] });
      qc.invalidateQueries({ queryKey: ["contact", item?.contact_id] });
    },
    onError: (e) => { setError((e as Error).message); setLinkStatus(""); },
  });

  useEffect(() => {
    if (item && !recatInit) {
      setRecatCategory(item.category);
      setRecatBusiness(item.business_id);
      setRecatBusinesses(item.business_id ? [item.business_id] : []);
      setRecatInit(true);
    }
  }, [item, recatInit]);

  if (!item) return <div className="p-10 text-slate-400 dark:text-slate-500">Loading…</div>;
  const isPhone = item.channel !== "email";

  function act(patch: Partial<QueueItem>) {
    action.mutate({ id: item!.id, patch });
    nav(-1);
  }

  const isExpenseCat = recatCategory === "receipt" || recatCategory === "expense";

  async function handleRecat() {
    setRecatStatus("saving");
    setError("");

    if (isExpenseCat && recatBusinesses.length > 1) {
      const splitLabel = `1/${recatBusinesses.length} split`;
      const [firstBiz, ...restBizs] = recatBusinesses;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setError("Not authenticated"); setRecatStatus(""); return; }
      // Update this item to the first business
      const { error: rpcErr } = await supabase.rpc("recategorize_queue_item", {
        p_queue_item_id: item!.id,
        p_category: recatCategory,
        p_business_id: firstBiz,
      });
      if (rpcErr) { setError(rpcErr.message); setRecatStatus(""); return; }
      // Tag the original with the split note
      await supabase.from("queue_items").update({
        priority_reasons: [...(item!.priority_reasons ?? []).filter(r => !r.startsWith("1/")), splitLabel],
      }).eq("id", item!.id);
      // Create copies for remaining businesses
      for (const bizId of restBizs) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: insErr } = await supabase.from("queue_items").insert({
          user_id: (await supabase.auth.getUser()).data.user!.id,
          thread_id: item!.thread_id,
          contact_id: item!.contact_id,
          business_id: bizId,
          category: recatCategory,
          state: item!.state,
          priority: item!.priority,
          channel: item!.channel,
          sender_name: item!.sender_name,
          sender_identifier: item!.sender_identifier,
          title: item!.title,
          preview: item!.preview,
          priority_reasons: [splitLabel],
        } as any);
        if (insErr) { setError(insErr.message); setRecatStatus(""); return; }
      }
    } else {
      const bizId = isExpenseCat ? (recatBusinesses[0] ?? null) : recatBusiness;
      const { error: rpcErr } = await supabase.rpc("recategorize_queue_item", {
        p_queue_item_id: item!.id,
        p_category: recatCategory,
        p_business_id: bizId,
      });
      if (rpcErr) { setError(rpcErr.message); setRecatStatus(""); return; }
    }

    setRecatStatus("saved");
    qc.invalidateQueries({ queryKey: ["item", id] });
    qc.invalidateQueries({ queryKey: ["queue"] });
  }

  const recatChanged = recatCategory !== item.category ||
    (isExpenseCat
      ? JSON.stringify([...(recatBusinesses)].sort()) !== JSON.stringify([item.business_id ?? ""].filter(Boolean))
      : recatBusiness !== item.business_id);

  return (
    <div className="max-w-5xl mx-auto p-6 grid grid-cols-[1fr_340px] gap-6">
      <div className="min-w-0">
        <button onClick={() => nav(-1)} className="flex items-center gap-1 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <h1 className="text-xl font-bold truncate">{item.title || "(no subject)"}</h1>
          <BusinessChip businesses={businesses} id={item.business_id} />
          <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">{item.state.replace("_", " ")}</span>
        </div>
        <div className="text-sm text-slate-500 dark:text-slate-400">
          {item.sender_name || item.sender_identifier}
          {contact && (
            <> · <Link className="text-indigo-600 dark:text-indigo-400 hover:underline" to={`/contacts/${contact.id}`}>contact</Link></>
          )}
        </div>

        <div className="mt-4 space-y-3">
          {messages.map((m) => <MessageBubble key={m.id} m={m} />)}
        </div>

        {isPhone ? (
          <div className="mt-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-3">
            <textarea
              value={smsText}
              onChange={(e) => setSmsText(e.target.value)}
              placeholder={`Reply by ${item.channel === "whatsapp" ? "WhatsApp" : "text"}…`}
              className="w-full text-sm border-0 focus:outline-none resize-none bg-transparent dark:text-slate-100 dark:placeholder-slate-500"
              rows={3}
            />
            <div className="flex justify-end">
              <button
                onClick={() => sendSms.mutate()}
                disabled={!smsText.trim() || sendSms.isPending}
                className="flex items-center gap-1 bg-indigo-600 text-white rounded-lg px-4 py-2 text-sm disabled:opacity-50"
              >
                <Send className="w-4 h-4" /> Send
              </button>
            </div>
          </div>
        ) : (
          <p className="mt-4 text-xs text-slate-400 dark:text-slate-500">
            Reply from Gmail as usual — the moment your reply lands in Sent, this flips to "responded" automatically (with the evidence shown on the right).
          </p>
        )}

        {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

        {draft && (
          <div className="mt-4 bg-indigo-50 dark:bg-indigo-950 border border-indigo-200 dark:border-indigo-800 rounded-xl p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-indigo-800 dark:text-indigo-200">Strategy draft</span>
              <button
                onClick={() => { navigator.clipboard.writeText(draft.text); }}
                className="text-xs bg-indigo-600 text-white rounded px-2 py-1"
              >
                Copy to clipboard
              </button>
            </div>
            <pre className="mt-2 text-sm whitespace-pre-wrap font-sans">{draft.text}</pre>
            {draft.notes && <p className="mt-2 text-xs text-indigo-700 dark:text-indigo-400">{draft.notes}</p>}
          </div>
        )}
      </div>

      <aside className="space-y-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-4">
          <h3 className="text-sm font-semibold">Actions</h3>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button onClick={() => act({ state: "responded" })}
              className="flex items-center justify-center gap-1 bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 rounded-lg py-2 text-sm hover:bg-emerald-100 dark:hover:bg-emerald-900">
              <Check className="w-4 h-4" /> Responded
            </button>
            <button onClick={() => act({ state: "dismissed" })}
              className="flex items-center justify-center gap-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-lg py-2 text-sm hover:bg-slate-200 dark:hover:bg-slate-700">
              <X className="w-4 h-4" /> Dismiss
            </button>
            <button onClick={() => act({ state: "snoozed", snoozed_until: new Date(Date.now() + 4 * 3600_000).toISOString() })}
              className="flex items-center justify-center gap-1 bg-sky-50 dark:bg-sky-950 text-sky-700 dark:text-sky-400 rounded-lg py-2 text-sm hover:bg-sky-100 dark:hover:bg-sky-900">
              <Clock className="w-4 h-4" /> Snooze 4h
            </button>
            <button onClick={() => act({ state: "snoozed", snoozed_until: new Date(Date.now() + 24 * 3600_000).toISOString() })}
              className="flex items-center justify-center gap-1 bg-sky-50 dark:bg-sky-950 text-sky-700 dark:text-sky-400 rounded-lg py-2 text-sm hover:bg-sky-100 dark:hover:bg-sky-900">
              <Clock className="w-4 h-4" /> Tomorrow
            </button>
          </div>
          <div className="col-span-2 mt-1">
            {blockStatus === "confirming" ? (
              <div className="flex gap-2">
                <button
                  onClick={() => { setBlockStatus("blocking"); blockSender.mutate(); }}
                  className="flex-1 flex items-center justify-center gap-1 bg-red-600 text-white rounded-lg py-2 text-sm hover:bg-red-700"
                >
                  <Ban className="w-4 h-4" /> Yes, block
                </button>
                <button
                  onClick={() => setBlockStatus("")}
                  className="flex-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-lg py-2 text-sm hover:bg-slate-200 dark:hover:bg-slate-700"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setBlockStatus("confirming")}
                disabled={blockStatus === "blocking"}
                className="w-full flex items-center justify-center gap-1 bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-400 rounded-lg py-2 text-sm hover:bg-red-100 dark:hover:bg-red-900 disabled:opacity-50"
              >
                <Ban className="w-4 h-4" />
                {blockStatus === "blocking" ? "Blocking…" : "Block sender"}
              </button>
            )}
            {blockStatus === "confirming" && (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 text-center">
                Suppresses this item + all open items from <strong>{item.sender_identifier}</strong>, and blocks future messages.
              </p>
            )}
          </div>
          {strategy && comm != null && (
            <button
              onClick={() => draftMutation.mutate()}
              disabled={draftMutation.isPending || strategy.allowed_zone === "red"}
              className="mt-2 w-full flex items-center justify-center gap-1 bg-indigo-600 text-white rounded-lg py-2 text-sm hover:bg-indigo-700 disabled:opacity-50"
            >
              <Sparkles className="w-4 h-4" />
              {draftMutation.isPending ? "Drafting…" : "Draft reply using strategy"}
            </button>
          )}
          {strategy && item.state === "responded" && (
            <button
              onClick={() => logOutcome.mutate()}
              disabled={logOutcome.isPending}
              className="mt-2 w-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg py-2 text-sm hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50"
            >
              {logOutcome.isPending ? "Logging…" : logOutcome.isSuccess ? "Outcome logged ✓" : "Log outcome → update strategy"}
            </button>
          )}
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-4">
          <h3 className="text-sm font-semibold">Recategorize</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Saving also trains a rule so future messages from this sender are pre-routed.
          </p>
          <div className="mt-2 space-y-2">
            <select
              value={recatCategory}
              onChange={(e) => {
                setRecatCategory(e.target.value);
                setRecatStatus("");
                // Reset business selection when switching to/from expense categories
                if (e.target.value === "receipt" || e.target.value === "expense") {
                  setRecatBusinesses(item.business_id ? [item.business_id] : []);
                }
              }}
              className="w-full border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-slate-800 dark:text-slate-100"
            >
              {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            {isExpenseCat ? (
              <>
                <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-2 space-y-1.5 max-h-44 overflow-y-auto">
                  {businesses.map((b) => (
                    <label key={b.id} className="flex items-center gap-2 text-sm cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={recatBusinesses.includes(b.id)}
                        onChange={(e) => {
                          setRecatBusinesses((prev) =>
                            e.target.checked ? [...prev, b.id] : prev.filter((x) => x !== b.id)
                          );
                          setRecatStatus("");
                        }}
                        className="rounded border-slate-300 text-indigo-600"
                      />
                      {b.name}
                    </label>
                  ))}
                </div>
                {recatBusinesses.length > 1 && (
                  <p className="text-xs text-indigo-700 dark:text-indigo-400">
                    Will create {recatBusinesses.length} items — one per business, each marked "1/{recatBusinesses.length} split."
                  </p>
                )}
              </>
            ) : (
              <select
                value={recatBusiness ?? ""}
                onChange={(e) => { setRecatBusiness(e.target.value || null); setRecatStatus(""); }}
                className="w-full border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-slate-800 dark:text-slate-100"
              >
                <option value="">No business</option>
                {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            )}
            <button
              onClick={handleRecat}
              disabled={recatStatus === "saving" || !recatChanged || (isExpenseCat && recatBusinesses.length === 0)}
              className="w-full bg-indigo-600 text-white rounded-lg py-1.5 text-sm hover:bg-indigo-700 disabled:opacity-50"
            >
              {recatStatus === "saving"
                ? "Saving…"
                : recatStatus === "saved"
                ? `Saved ✓ · rule created`
                : isExpenseCat && recatBusinesses.length > 1
                ? `Split across ${recatBusinesses.length} · save & train rule`
                : "Save & train rule"}
            </button>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-4">
          <h3 className="text-sm font-semibold flex items-center gap-1">
            <UserPlus className="w-4 h-4 text-slate-400 dark:text-slate-500" />
            {contact?.kind === "unknown" ? "Who is this from?" : "Reassign sender"}
          </h3>
          {contact?.kind === "unknown" && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
              <strong>{item.sender_identifier}</strong> hasn't been linked to a contact yet.
            </p>
          )}
          <div className="mt-2 relative">
            <input
              type="text"
              value={linkSearch}
              onChange={(e) => { setLinkSearch(e.target.value); setLinkSelected(null); setLinkStatus(""); }}
              placeholder="Search contacts by name…"
              className="w-full border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-slate-800 dark:text-slate-100"
            />
            {linkResults.length > 0 && !linkSelected && (
              <ul className="absolute z-10 left-0 right-0 mt-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow text-sm overflow-hidden">
                {linkResults.map((c) => (
                  <li key={c.id}>
                    <button
                      onClick={() => { setLinkSelected(c); setLinkSearch(c.display_name); setLinkResults([]); }}
                      className="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      {c.display_name}
                      {c.kind === "unknown" && (
                        <span className="ml-1 text-xs text-slate-400 dark:text-slate-500">(unknown)</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {linkSelected && linkStatus !== "saved" && (
            <div className="mt-2">
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Links <strong>{item.sender_identifier}</strong> to{" "}
                <strong>{linkSelected.display_name}</strong> — updates all past and future messages.
              </p>
              <button
                onClick={() => { setLinkStatus("saving"); linkSender.mutate(); }}
                disabled={linkStatus === "saving"}
                className="mt-1 w-full bg-indigo-600 text-white rounded-lg py-1.5 text-sm hover:bg-indigo-700 disabled:opacity-50"
              >
                {linkStatus === "saving" ? "Linking…" : `Link to ${linkSelected.display_name}`}
              </button>
            </div>
          )}
          {linkStatus === "saved" && (
            <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">Linked ✓ — all messages updated.</p>
          )}
        </div>

        <StrategyPanel item={item} strategy={strategy} comm={comm ?? null} />

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-4">
          <h3 className="text-sm font-semibold">History & evidence</h3>
          <ul className="mt-2 space-y-2 text-xs text-slate-600 dark:text-slate-400">
            {item.priority_reasons?.length > 0 && (
              <li className="text-slate-500 dark:text-slate-500">Priority: {item.priority_reasons.join(" · ")}</li>
            )}
            {events.map((e) => (
              <li key={e.id} className="border-l-2 border-slate-200 dark:border-slate-700 pl-2">
                <span className={e.actor === "system" ? "text-indigo-600 dark:text-indigo-400" : "text-emerald-700 dark:text-emerald-500"}>
                  {e.actor}
                </span>{" "}
                {e.from_state} → <strong>{e.to_state}</strong>
                {e.reason && <> · {e.reason.replaceAll("_", " ")}</>}
                <span className="text-slate-400 dark:text-slate-500"> · {fmtWhen(e.created_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}

function MessageBubble({ m }: { m: Message }) {
  const [body, setBody] = useState<string | null>(m.body_text);
  const [loading, setLoading] = useState(false);
  const inbound = m.direction === "inbound";

  async function loadBody() {
    setLoading(true);
    try {
      const res = await api<{ body: string }>("gmail-get-body", { message_id: m.id });
      setBody(res.body || "(no text body)");
    } catch (e) {
      setBody(`could not load body: ${(e as Error).message}`);
    }
    setLoading(false);
  }

  return (
    <div className={`rounded-xl border p-3 ${inbound
      ? "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700"
      : "bg-indigo-50 dark:bg-indigo-950/50 border-indigo-100 dark:border-indigo-900 ml-8"}`}>
      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="font-medium text-slate-700 dark:text-slate-300">{inbound ? (m.from_name || m.from_identifier) : "You"}</span>
        <span>{new Date(m.sent_at).toLocaleString()}</span>
      </div>
      <div className="mt-1 text-sm whitespace-pre-wrap">
        {body ?? m.snippet}
        {!body && m.channel === "email" && (
          <button onClick={loadBody} disabled={loading} className="block mt-1 text-xs text-indigo-600 dark:text-indigo-400 hover:underline">
            {loading ? "Loading…" : "Show full message"}
          </button>
        )}
      </div>
    </div>
  );
}
