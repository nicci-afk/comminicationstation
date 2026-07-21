// One attention episode: the conversation, the trust ledger (why it's here,
// every automated transition with evidence), the stored strategy, drafting,
// and the resolution actions.
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Clock, Send, Sparkles, X } from "lucide-react";
import { api, supabase } from "../lib/supabase";
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

  const logOutcome = useMutation({
    mutationFn: async () =>
      await api("interaction-update", { mode: "auto", strategy_id: strategy!.id, queue_item_id: id }),
    onError: (e) => setError((e as Error).message),
  });

  if (!item) return <div className="p-10 text-slate-400">Loading…</div>;
  const isPhone = item.channel !== "email";

  function act(patch: Partial<QueueItem>) {
    action.mutate({ id: item!.id, patch });
    nav(-1);
  }

  return (
    <div className="max-w-5xl mx-auto p-6 grid grid-cols-[1fr_340px] gap-6">
      <div className="min-w-0">
        <button onClick={() => nav(-1)} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <h1 className="text-xl font-bold truncate">{item.title || "(no subject)"}</h1>
          <BusinessChip businesses={businesses} id={item.business_id} />
          <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{item.state.replace("_", " ")}</span>
        </div>
        <div className="text-sm text-slate-500">
          {item.sender_name || item.sender_identifier}
          {contact && (
            <> · <Link className="text-indigo-600 hover:underline" to={`/contacts/${contact.id}`}>contact</Link></>
          )}
        </div>

        <div className="mt-4 space-y-3">
          {messages.map((m) => <MessageBubble key={m.id} m={m} />)}
        </div>

        {isPhone ? (
          <div className="mt-4 bg-white border border-slate-200 rounded-xl p-3">
            <textarea
              value={smsText}
              onChange={(e) => setSmsText(e.target.value)}
              placeholder={`Reply by ${item.channel === "whatsapp" ? "WhatsApp" : "text"}…`}
              className="w-full text-sm border-0 focus:outline-none resize-none"
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
          <p className="mt-4 text-xs text-slate-400">
            Reply from Gmail as usual — the moment your reply lands in Sent, this flips to “responded” automatically (with the evidence shown on the right).
          </p>
        )}

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        {draft && (
          <div className="mt-4 bg-indigo-50 border border-indigo-200 rounded-xl p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-indigo-800">Strategy draft</span>
              <button
                onClick={() => { navigator.clipboard.writeText(draft.text); }}
                className="text-xs bg-indigo-600 text-white rounded px-2 py-1"
              >
                Copy to clipboard
              </button>
            </div>
            <pre className="mt-2 text-sm whitespace-pre-wrap font-sans">{draft.text}</pre>
            {draft.notes && <p className="mt-2 text-xs text-indigo-700">{draft.notes}</p>}
          </div>
        )}
      </div>

      <aside className="space-y-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <h3 className="text-sm font-semibold">Actions</h3>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button onClick={() => act({ state: "responded" })}
              className="flex items-center justify-center gap-1 bg-emerald-50 text-emerald-700 rounded-lg py-2 text-sm hover:bg-emerald-100">
              <Check className="w-4 h-4" /> Responded
            </button>
            <button onClick={() => act({ state: "dismissed" })}
              className="flex items-center justify-center gap-1 bg-slate-100 text-slate-600 rounded-lg py-2 text-sm hover:bg-slate-200">
              <X className="w-4 h-4" /> Dismiss
            </button>
            <button onClick={() => act({ state: "snoozed", snoozed_until: new Date(Date.now() + 4 * 3600_000).toISOString() })}
              className="flex items-center justify-center gap-1 bg-sky-50 text-sky-700 rounded-lg py-2 text-sm hover:bg-sky-100">
              <Clock className="w-4 h-4" /> Snooze 4h
            </button>
            <button onClick={() => act({ state: "snoozed", snoozed_until: new Date(Date.now() + 24 * 3600_000).toISOString() })}
              className="flex items-center justify-center gap-1 bg-sky-50 text-sky-700 rounded-lg py-2 text-sm hover:bg-sky-100">
              <Clock className="w-4 h-4" /> Tomorrow
            </button>
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
              className="mt-2 w-full bg-slate-100 text-slate-700 rounded-lg py-2 text-sm hover:bg-slate-200 disabled:opacity-50"
            >
              {logOutcome.isPending ? "Logging…" : logOutcome.isSuccess ? "Outcome logged ✓" : "Log outcome → update strategy"}
            </button>
          )}
        </div>

        <StrategyPanel item={item} strategy={strategy} comm={comm ?? null} />

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <h3 className="text-sm font-semibold">History & evidence</h3>
          <ul className="mt-2 space-y-2 text-xs text-slate-600">
            {item.priority_reasons?.length > 0 && (
              <li className="text-slate-500">Priority: {item.priority_reasons.join(" · ")}</li>
            )}
            {events.map((e) => (
              <li key={e.id} className="border-l-2 border-slate-200 pl-2">
                <span className={e.actor === "system" ? "text-indigo-600" : "text-emerald-700"}>
                  {e.actor}
                </span>{" "}
                {e.from_state} → <strong>{e.to_state}</strong>
                {e.reason && <> · {e.reason.replaceAll("_", " ")}</>}
                <span className="text-slate-400"> · {fmtWhen(e.created_at)}</span>
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
    <div className={`rounded-xl border p-3 ${inbound ? "bg-white border-slate-200" : "bg-indigo-50 border-indigo-100 ml-8"}`}>
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="font-medium text-slate-700">{inbound ? (m.from_name || m.from_identifier) : "You"}</span>
        <span>{new Date(m.sent_at).toLocaleString()}</span>
      </div>
      <div className="mt-1 text-sm whitespace-pre-wrap">
        {body ?? m.snippet}
        {!body && m.channel === "email" && (
          <button onClick={loadBody} disabled={loading} className="block mt-1 text-xs text-indigo-600 hover:underline">
            {loading ? "Loading…" : "Show full message"}
          </button>
        )}
      </div>
    </div>
  );
}
