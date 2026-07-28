// Contact profile + the "Analyze contact" trigger (the only place the
// expensive 3-stage pipeline can start) + full stored strategy rendering.
// Also hosts: Edit contact, Log interaction (post-interaction update packet).
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, GitMerge, MessageSquare, Pencil, Play, Star } from "lucide-react";
import { api, supabase } from "../lib/supabase";
import { fmtWhen, useArtifactOutput, useBusinesses, useContact, useContactChannels, useStrategies } from "../lib/hooks";
import type { Contact, ContactChannel, PipelineRun } from "../lib/types";

export default function ContactDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: contact } = useContact(id ?? null);
  const { data: channels = [] } = useContactChannels(id ?? null);
  const { data: strategies = [] } = useStrategies(id ?? null);
  const { data: businesses = [] } = useBusinesses();
  const [showAnalyze, setShowAnalyze] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showInteraction, setShowInteraction] = useState(false);
  const [showMerge, setShowMerge] = useState(false);
  const strategy = strategies[0] ?? null;
  const { data: comm } = useArtifactOutput(strategy?.comm_artifact_id ?? null);
  const { data: persona } = useArtifactOutput(strategy?.persona_artifact_id ?? null);

  const { data: runs = [] } = useQuery({
    queryKey: ["runs", id],
    refetchInterval: (q) => {
      const data = q.state.data as PipelineRun[] | undefined;
      return data?.some((r) => !["complete", "error", "qc_failed", "cancelled"].includes(r.status)) ? 4000 : false;
    },
    queryFn: async (): Promise<PipelineRun[]> => {
      const { data, error } = await supabase
        .from("pipeline_runs")
        .select("id,contact_id,status,current_stage,error,total_cost_usd,created_at,finished_at")
        .eq("contact_id", id!)
        .order("created_at", { ascending: false })
        .limit(5);
      if (error) throw error;
      return data ?? [];
    },
  });
  const activeRun = runs.find((r) => !["complete", "error", "qc_failed", "cancelled"].includes(r.status));

  const toggleVip = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("contacts").update({ is_vip: !contact!.is_vip }).eq("id", id!);
      if (error) throw error;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["contact", id] }),
  });

  if (!contact) return <div className="p-10 text-slate-400 dark:text-slate-500">Loading…</div>;

  return (
    <div className="max-w-3xl mx-auto p-8">
      <button onClick={() => nav(-1)} className="flex items-center gap-1 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200">
        <ArrowLeft className="w-4 h-4" /> Back
      </button>
      <div className="mt-2 flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-bold">{contact.display_name}</h1>
        <button onClick={() => toggleVip.mutate()} title="Toggle VIP">
          <Star className={`w-5 h-5 ${contact.is_vip ? "text-amber-500" : "text-slate-300 dark:text-slate-600"}`}
            fill={contact.is_vip ? "currentColor" : "none"} />
        </button>
        <button onClick={() => setShowEdit(true)} title="Edit contact" className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
          <Pencil className="w-4 h-4" />
        </button>
        <button onClick={() => setShowMerge(true)} title="Merge into another contact" className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
          <GitMerge className="w-4 h-4" />
        </button>
        <span className="text-xs px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded-full text-slate-500 dark:text-slate-400">{contact.kind}</span>
        <span className="text-xs text-slate-400 dark:text-slate-500">seen {fmtWhen(contact.last_seen_at)}</span>
      </div>

      {(channels.length > 0 || contact.birthday || contact.address || contact.notes) && (
        <div className="mt-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-4 space-y-1.5">
          {channels.filter((ch) => ch.channel_type === "email").map((ch) => (
            <div key={ch.id} className="flex items-center gap-2 text-sm">
              <span className="text-xs font-medium text-slate-400 w-12 shrink-0">email</span>
              <a href={`mailto:${ch.canonical_value}`} className="text-indigo-600 dark:text-indigo-400 hover:underline truncate">
                {ch.canonical_value}
              </a>
            </div>
          ))}
          {channels.filter((ch) => ch.channel_type === "phone").map((ch) => (
            <div key={ch.id} className="flex items-center gap-2 text-sm">
              <span className="text-xs font-medium text-slate-400 w-12 shrink-0">phone</span>
              <a href={`tel:${ch.canonical_value}`} className="text-slate-700 dark:text-slate-300 hover:underline">
                {ch.raw_value || ch.canonical_value}
              </a>
            </div>
          ))}
          {contact.birthday && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-xs font-medium text-slate-400 w-12 shrink-0">birthday</span>
              <span className="text-slate-700 dark:text-slate-300">{new Date(contact.birthday + "T00:00:00").toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}</span>
            </div>
          )}
          {contact.address && (
            <div className="flex items-start gap-2 text-sm">
              <span className="text-xs font-medium text-slate-400 w-12 shrink-0 pt-0.5">address</span>
              <span className="text-slate-700 dark:text-slate-300 whitespace-pre-wrap">{contact.address}</span>
            </div>
          )}
          {contact.notes && (
            <div className="flex gap-2 text-sm pt-1 border-t border-slate-100 dark:border-slate-800">
              <span className="text-xs font-medium text-slate-400 w-12 shrink-0 pt-0.5">notes</span>
              <span className="text-slate-600 dark:text-slate-400 whitespace-pre-wrap">{contact.notes}</span>
            </div>
          )}
        </div>
      )}

      <div className="mt-4 flex items-center gap-2 flex-wrap">
        {activeRun ? (
          <div className="flex-1 bg-indigo-50 dark:bg-indigo-950/50 border border-indigo-200 dark:border-indigo-800 rounded-xl p-4 text-sm">
            <div className="font-medium text-indigo-800 dark:text-indigo-200">Analysis running — stage {activeRun.current_stage} of 3</div>
            <div className="mt-2 flex gap-1">
              {[1, 2, 3].map((s) => (
                <div key={s} className={`h-2 flex-1 rounded-full ${
                  activeRun.current_stage > s || activeRun.status === `stage${s}_done` ? "bg-indigo-500"
                  : activeRun.current_stage === s ? "bg-indigo-300 animate-pulse" : "bg-slate-200 dark:bg-slate-700"}`} />
              ))}
            </div>
            <p className="mt-2 text-xs text-indigo-700 dark:text-indigo-400">
              1 · Perplexity public-web research → 2 · persona strategy → 3 · communication strategy
            </p>
          </div>
        ) : (
          <button
            onClick={() => setShowAnalyze(true)}
            className="flex items-center gap-2 bg-indigo-600 text-white rounded-xl px-4 py-2 text-sm font-medium hover:bg-indigo-700"
          >
            <Play className="w-4 h-4" /> {strategy ? "Re-analyze contact" : "Analyze contact"}
          </button>
        )}
        {strategy && (
          <button
            onClick={() => setShowInteraction(true)}
            className="flex items-center gap-2 border border-slate-300 dark:border-slate-600 rounded-xl px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <MessageSquare className="w-4 h-4" /> Log interaction
          </button>
        )}
      </div>

      {runs[0] && ["error", "qc_failed"].includes(runs[0].status) && (
        <div className="mt-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-xl p-3 text-xs text-red-700 dark:text-red-300">
          Last run {runs[0].status === "qc_failed" ? "failed quality-control gates" : "errored"}: {runs[0].error}
        </div>
      )}

      {showEdit && (
        <EditContactDialog
          contact={contact}
          channels={channels}
          onClose={() => {
            setShowEdit(false);
            qc.invalidateQueries({ queryKey: ["contact", id] });
            qc.invalidateQueries({ queryKey: ["contact-channels", id] });
          }}
        />
      )}

      {showMerge && (
        <MergeContactDialog
          sourceContactId={id!}
          sourceContactName={contact.display_name}
          onClose={() => setShowMerge(false)}
          onMerged={(targetId) => nav(`/contacts/${targetId}`, { replace: true })}
        />
      )}

      {showAnalyze && (
        <AnalyzeDialog
          contactId={id!}
          contactName={contact.display_name}
          businesses={businesses}
          onClose={() => { setShowAnalyze(false); qc.invalidateQueries({ queryKey: ["runs", id] }); }}
        />
      )}

      {showInteraction && strategy && (
        <InteractionUpdateDialog
          strategyId={strategy.id}
          contactName={contact.display_name}
          onClose={() => {
            setShowInteraction(false);
            qc.invalidateQueries({ queryKey: ["strategies", id] });
          }}
        />
      )}

      {strategy && comm != null && (
        <StrategyFull strategy={strategy} comm={comm} persona={persona ?? null} />
      )}
    </div>
  );
}

// ─── Edit contact dialog ──────────────────────────────────────────────────────

function EditContactDialog({
  contact,
  channels,
  onClose,
}: {
  contact: Contact;
  channels: ContactChannel[];
  onClose: () => void;
}) {
  const [name, setName] = useState(contact.display_name);
  const [kind, setKind] = useState(contact.kind);
  const [birthday, setBirthday] = useState(contact.birthday ?? "");
  const [address, setAddress] = useState(contact.address ?? "");
  const [notes, setNotes] = useState(contact.notes ?? "");
  const [localChannels, setLocalChannels] = useState(channels);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [error, setError] = useState("");

  function removeChannel(channelId: string) {
    setLocalChannels((prev) => prev.filter((c) => c.id !== channelId));
    setDeletedIds((prev) => [...prev, channelId]);
  }

  const save = useMutation({
    mutationFn: async () => {
      const { error: e1 } = await supabase.from("contacts").update({
        display_name: name.trim() || contact.display_name,
        kind,
        birthday: birthday || null,
        address: address.trim() || null,
        notes,
      }).eq("id", contact.id);
      if (e1) throw new Error(e1.message);

      for (const cid of deletedIds) {
        const { error: e2 } = await supabase.from("contact_channels").delete().eq("id", cid);
        if (e2) throw new Error(e2.message);
      }

      const { data: { user } } = await supabase.auth.getUser();
      const uid = user!.id;

      if (newEmail.trim() && newEmail.includes("@")) {
        const addr = newEmail.trim().toLowerCase();
        const { error: e3 } = await supabase.from("contact_channels").insert({
          contact_id: contact.id, user_id: uid,
          channel_type: "email", raw_value: addr, canonical_value: addr,
        });
        if (e3 && !e3.code?.includes("23505")) throw new Error(e3.message);
      }

      if (newPhone.trim()) {
        const canonical = newPhone.trim().replace(/[\s\-\(\)\.]/g, "");
        if (canonical.replace(/[^0-9]/g, "").length > 3) {
          const { error: e4 } = await supabase.from("contact_channels").insert({
            contact_id: contact.id, user_id: uid,
            channel_type: "phone", raw_value: newPhone.trim(), canonical_value: canonical,
          });
          if (e4 && !e4.code?.includes("23505")) throw new Error(e4.message);
        }
      }
    },
    onSuccess: onClose,
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="fixed inset-0 bg-black/30 grid place-items-center z-50" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 w-[520px] space-y-3 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-semibold">Edit contact</h2>

        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name"
          className="w-full border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-slate-800 dark:text-slate-100" />

        <div className="grid grid-cols-2 gap-2">
          <select value={kind} onChange={(e) => setKind(e.target.value as "human" | "automated" | "organization" | "unknown")}
            className="border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-slate-800 dark:text-slate-100">
            <option value="human">human</option>
            <option value="organization">organization</option>
            <option value="automated">automated</option>
            <option value="unknown">unknown</option>
          </select>
          <input type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)}
            className="border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-slate-800 dark:text-slate-100" />
        </div>

        <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Home address (optional)"
          className="w-full border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-slate-800 dark:text-slate-100" />

        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4}
          placeholder="Notes…"
          className="w-full border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm resize-y bg-white dark:bg-slate-800 dark:text-slate-100" />

        <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-3 space-y-2">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Channels</p>
          {localChannels.length === 0 && (
            <p className="text-xs text-slate-400 dark:text-slate-500">No channels yet — add one below.</p>
          )}
          {localChannels.map((ch) => (
            <div key={ch.id} className="flex items-center gap-2 text-sm">
              <span className="text-xs text-slate-400 dark:text-slate-500 w-10 shrink-0">{ch.channel_type}</span>
              <span className="flex-1 font-mono text-xs truncate dark:text-slate-300">{ch.canonical_value}</span>
              <button type="button" onClick={() => removeChannel(ch.id)}
                className="text-xs text-red-400 hover:text-red-600 shrink-0">remove</button>
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)}
              placeholder="Add email address"
              className="flex-1 border border-slate-300 dark:border-slate-600 rounded-lg px-2 py-1.5 text-xs bg-white dark:bg-slate-800 dark:text-slate-100" />
            <input value={newPhone} onChange={(e) => setNewPhone(e.target.value)}
              placeholder="Add phone"
              className="flex-1 border border-slate-300 dark:border-slate-600 rounded-lg px-2 py-1.5 text-xs bg-white dark:bg-slate-800 dark:text-slate-100" />
          </div>
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-slate-500 dark:text-slate-400">Cancel</button>
          <button type="button" onClick={() => save.mutate()} disabled={save.isPending}
            className="bg-indigo-600 text-white rounded-lg px-4 py-2 text-sm disabled:opacity-50">
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Merge contact dialog ─────────────────────────────────────────────────────

function MergeContactDialog({
  sourceContactId,
  sourceContactName,
  onClose,
  onMerged,
}: {
  sourceContactId: string;
  sourceContactName: string;
  onClose: () => void;
  onMerged: (targetContactId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<{ id: string; display_name: string; kind: string }[]>([]);
  const [selected, setSelected] = useState<{ id: string; display_name: string } | null>(null);
  const [status, setStatus] = useState<"" | "confirming" | "merging" | "done">("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!search.trim()) { setResults([]); return; }
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from("contacts")
        .select("id, display_name, kind")
        .ilike("display_name", `%${search}%`)
        .is("merged_into_contact_id", null)
        .neq("id", sourceContactId)
        .limit(6);
      setResults((data as { id: string; display_name: string; kind: string }[]) ?? []);
    }, 250);
    return () => clearTimeout(t);
  }, [search, sourceContactId]);

  const merge = useMutation({
    mutationFn: async () =>
      await api<{ target_contact_id: string }>("contact-merge", {
        source_contact_id: sourceContactId,
        target_contact_id: selected!.id,
      }),
    onSuccess: (res) => {
      setStatus("done");
      onMerged(res.target_contact_id);
    },
    onError: (e) => { setError((e as Error).message); setStatus(""); },
  });

  return (
    <div className="fixed inset-0 bg-black/30 grid place-items-center z-50" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 w-[480px] space-y-4" onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="font-semibold">Merge contact</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            All channels, messages, and queue items from{" "}
            <strong>{sourceContactName}</strong> will move to the contact you choose.
            The original record is tombstoned (hidden, not deleted). This cannot be undone.
          </p>
        </div>

        <div className="relative">
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setSelected(null); setStatus(""); setError(""); }}
            placeholder="Search for the contact to merge into…"
            className="w-full border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-slate-800 dark:text-slate-100"
            autoFocus
          />
          {results.length > 0 && !selected && (
            <ul className="absolute z-10 left-0 right-0 mt-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow text-sm overflow-hidden">
              {results.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => { setSelected(c); setSearch(c.display_name); setResults([]); setStatus("confirming"); }}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-2"
                  >
                    <span className="flex-1">{c.display_name}</span>
                    {c.kind === "unknown" && <span className="text-xs text-slate-400 dark:text-slate-500">unknown</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {selected && status === "confirming" && (
          <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-xl p-3 text-sm text-amber-800 dark:text-amber-200 space-y-1">
            <p>
              Merge <strong>{sourceContactName}</strong> → <strong>{selected.display_name}</strong>?
            </p>
            <p className="text-xs">
              All channels (email addresses, phone numbers), every queue item, and every message
              from <strong>{sourceContactName}</strong> will be reassigned to{" "}
              <strong>{selected.display_name}</strong>.
            </p>
          </div>
        )}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-500 dark:text-slate-400">Cancel</button>
          {selected && status === "confirming" && (
            <button
              onClick={() => { setStatus("merging"); merge.mutate(); }}
              disabled={merge.isPending}
              className="bg-amber-600 text-white rounded-lg px-4 py-2 text-sm hover:bg-amber-700 disabled:opacity-50"
            >
              {merge.isPending ? "Merging…" : `Merge into ${selected.display_name}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Log interaction dialog ───────────────────────────────────────────────────

function TagInput({ value, onChange, placeholder }: {
  value: string[]; onChange: (v: string[]) => void; placeholder: string;
}) {
  const [input, setInput] = useState("");
  return (
    <div className="border border-slate-300 dark:border-slate-700 rounded-lg px-2 py-1.5 flex flex-wrap gap-1 min-h-[38px] bg-white dark:bg-slate-800">
      {value.map((tag, i) => (
        <span key={i} className="bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs px-2 py-0.5 rounded-full flex items-center gap-1">
          {tag}
          <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))}
            className="hover:text-red-500 leading-none">×</button>
        </span>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === ",") && input.trim()) {
            e.preventDefault();
            onChange([...value, input.trim()]);
            setInput("");
          }
        }}
        placeholder={value.length === 0 ? placeholder : "Enter to add…"}
        className="outline-none text-sm flex-1 min-w-[120px] bg-transparent dark:text-slate-100 dark:placeholder-slate-500"
      />
    </div>
  );
}

function InteractionUpdateDialog({
  strategyId,
  contactName,
  onClose,
}: {
  strategyId: string;
  contactName: string;
  onClose: () => void;
}) {
  const [whatSent, setWhatSent] = useState("");
  const [responseObserved, setResponseObserved] = useState("");
  const [responseClassification, setResponseClassification] = useState("");
  const [confidenceChange, setConfidenceChange] = useState<"increase" | "decrease" | "none">("none");
  const [frictionSignals, setFrictionSignals] = useState<string[]>([]);
  const [driftSignals, setDriftSignals] = useState<string[]>([]);
  const [recommendedUpdates, setRecommendedUpdates] = useState<string[]>([]);
  const [error, setError] = useState("");

  const submit = useMutation({
    mutationFn: async () =>
      await api("interaction-update", {
        strategy_id: strategyId,
        mode: "manual",
        packet: {
          what_was_sent: whatSent,
          response_observed: responseObserved,
          response_classification: responseClassification.trim() || "neutral",
          confidence_change: confidenceChange,
          friction_signals_observed: frictionSignals,
          drift_signals_observed: driftSignals,
          recommended_upstream_updates: recommendedUpdates,
        },
      }),
    onSuccess: onClose,
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="fixed inset-0 bg-black/30 grid place-items-center z-50" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 w-[560px] space-y-3 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-semibold">Log interaction with {contactName}</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Records what happened so the strategy evolves over time. Press Enter in tag fields to add each item.
          Drift signals or repeated confidence decreases will flag the strategy for re-analysis.
        </p>

        <div>
          <label className="text-xs font-medium text-slate-500 dark:text-slate-400">What you sent</label>
          <textarea value={whatSent} onChange={(e) => setWhatSent(e.target.value)} rows={3}
            placeholder="Key points of what you said or sent…"
            className="mt-1 w-full border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm resize-y bg-white dark:bg-slate-800 dark:text-slate-100" />
        </div>

        <div>
          <label className="text-xs font-medium text-slate-500 dark:text-slate-400">Response observed</label>
          <textarea value={responseObserved} onChange={(e) => setResponseObserved(e.target.value)} rows={3}
            placeholder="What they said or did in response — or 'no response yet'"
            className="mt-1 w-full border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm resize-y bg-white dark:bg-slate-800 dark:text-slate-100" />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs font-medium text-slate-500 dark:text-slate-400">Response classification</label>
            <input value={responseClassification} onChange={(e) => setResponseClassification(e.target.value)}
              placeholder="e.g. positive, objection, silence"
              className="mt-1 w-full border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-slate-800 dark:text-slate-100" />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500 dark:text-slate-400">Confidence change</label>
            <select value={confidenceChange} onChange={(e) => setConfidenceChange(e.target.value as typeof confidenceChange)}
              className="mt-1 w-full border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-slate-800 dark:text-slate-100">
              <option value="none">No change</option>
              <option value="increase">Increase — strategy is working</option>
              <option value="decrease">Decrease — something is off</option>
            </select>
          </div>
        </div>

        <div>
          <label className="text-xs font-medium text-slate-500 dark:text-slate-400">Friction signals (Enter to add)</label>
          <div className="mt-1">
            <TagInput value={frictionSignals} onChange={setFrictionSignals}
              placeholder="e.g. pushed back on price…" />
          </div>
        </div>

        <div>
          <label className="text-xs font-medium text-slate-500 dark:text-slate-400">Drift signals — surprises (Enter to add)</label>
          <div className="mt-1">
            <TagInput value={driftSignals} onChange={setDriftSignals}
              placeholder="e.g. mentioned new budget constraint…" />
          </div>
        </div>

        <div>
          <label className="text-xs font-medium text-slate-500 dark:text-slate-400">Recommended strategy updates (Enter to add)</label>
          <div className="mt-1">
            <TagInput value={recommendedUpdates} onChange={setRecommendedUpdates}
              placeholder="e.g. lead with flexibility next time…" />
          </div>
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-slate-500 dark:text-slate-400">Cancel</button>
          <button
            type="button"
            onClick={() => submit.mutate()}
            disabled={submit.isPending || !whatSent.trim() || !responseObserved.trim()}
            className="bg-indigo-600 text-white rounded-lg px-4 py-2 text-sm disabled:opacity-50"
          >
            {submit.isPending ? "Saving…" : "Log interaction"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Analyze dialog ───────────────────────────────────────────────────────────

function AnalyzeDialog({
  contactId, contactName, businesses, onClose,
}: {
  contactId: string; contactName: string;
  businesses: { id: string; name: string }[];
  onClose: () => void;
}) {
  const [businessId, setBusinessId] = useState("");
  const [fullName, setFullName] = useState(contactName);
  const [employer, setEmployer] = useState("");
  const [location, setLocation] = useState("");
  const [urls, setUrls] = useState("");
  const [useCase, setUseCase] = useState("");
  const [stakes, setStakes] = useState("medium");
  const [error, setError] = useState("");

  const start = useMutation({
    mutationFn: async () =>
      await api("pipeline-start", {
        contact_id: contactId,
        business_id: businessId || null,
        channel: "email",
        overrides: {
          full_name: fullName,
          target_label: fullName,
          employer: employer ? [employer] : [],
          location: location ? [location] : [],
          profile_urls: urls.split(/\s+/).filter(Boolean),
          ...(useCase ? { use_case: useCase } : {}),
          stakes_level: stakes,
        },
      }),
    onSuccess: onClose,
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="fixed inset-0 bg-black/30 grid place-items-center z-50" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 w-[480px] space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-semibold">Analyze {contactName}</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Runs the full 3-stage pipeline (Perplexity public-web research → ChatGPT persona strategy →
          Claude communication strategy) once, then stores and reuses the result. Roughly $0.05–0.30.
          The more identifiers you give it, the stronger the identity match.
        </p>
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Full name"
          className="w-full border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-slate-800 dark:text-slate-100" />
        <div className="grid grid-cols-2 gap-2">
          <input value={employer} onChange={(e) => setEmployer(e.target.value)} placeholder="Company (optional)"
            className="border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-slate-800 dark:text-slate-100" />
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location (optional)"
            className="border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-slate-800 dark:text-slate-100" />
        </div>
        <input value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="Profile URLs, space-separated (optional)"
          className="w-full border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-slate-800 dark:text-slate-100" />
        <input value={useCase} onChange={(e) => setUseCase(e.target.value)} placeholder="What's this relationship about? (optional)"
          className="w-full border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-slate-800 dark:text-slate-100" />
        <div className="grid grid-cols-2 gap-2">
          <select value={businessId} onChange={(e) => setBusinessId(e.target.value)}
            className="border border-slate-300 dark:border-slate-600 rounded-lg px-2 py-2 text-sm bg-white dark:bg-slate-800 dark:text-slate-100">
            <option value="">No specific business</option>
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <select value={stakes} onChange={(e) => setStakes(e.target.value)}
            className="border border-slate-300 dark:border-slate-600 rounded-lg px-2 py-2 text-sm bg-white dark:bg-slate-800 dark:text-slate-100">
            <option value="low">Low stakes</option>
            <option value="medium">Medium stakes</option>
            <option value="high">High stakes</option>
          </select>
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-500 dark:text-slate-400">Cancel</button>
          <button onClick={() => start.mutate()} disabled={start.isPending}
            className="bg-indigo-600 text-white rounded-lg px-4 py-2 text-sm disabled:opacity-50">
            {start.isPending ? "Starting…" : "Run analysis"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Strategy display ─────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-2 text-sm text-slate-700 dark:text-slate-300 space-y-1">{children}</div>
    </div>
  );
}

function StrategyFull({
  strategy, comm, persona,
}: {
  strategy: { id: string; allowed_zone: string; updated_at: string; re_analysis_recommended: boolean; re_analysis_reason: string };
  comm: Record<string, unknown>;
  persona: Record<string, unknown> | null;
}) {
  const blueprints = (comm.message_blueprints as Record<string, unknown>[]) ?? [];
  const sequencing = (comm.sequencing_plan as { step: number; goal: string; instruction: string }[]) ?? [];
  const interp = (comm.response_interpretation_rules as Record<string, string>[]) ?? [];
  const friction = (persona?.friction_risks as Record<string, unknown>[]) ?? [];
  const levers = (persona?.rapport_levers as Record<string, unknown>[]) ?? [];

  return (
    <div className="mt-6 space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">Stored strategy</h2>
        <span className={`text-xs px-2 py-0.5 rounded-full uppercase font-bold ${
          strategy.allowed_zone === "green" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
          : strategy.allowed_zone === "yellow" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
          : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"}`}>{strategy.allowed_zone}</span>
        <span className="text-xs text-slate-400 dark:text-slate-500">updated {fmtWhen(strategy.updated_at)}</span>
      </div>
      {strategy.re_analysis_recommended && (
        <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-xl p-3 text-sm text-amber-800 dark:text-amber-200">
          🔁 Re-analysis recommended — {strategy.re_analysis_reason}. Use the button above when ready
          (it never runs by itself).
        </div>
      )}
      <Section title="Objective & approach">
        <p><strong>Objective:</strong> {String(comm.message_objective ?? "")}</p>
        <p><strong>Approach:</strong> {String(comm.recommended_approach ?? "")}</p>
        <p className="text-xs text-slate-500 dark:text-slate-400"><strong>Safe next action:</strong> {String(comm.minimum_safe_next_action ?? "")}</p>
      </Section>
      {sequencing.length > 0 && (
        <Section title="Sequencing plan">
          <ol className="list-decimal ml-4 space-y-1">
            {sequencing.map((s) => <li key={s.step}><strong>{s.goal}:</strong> {s.instruction}</li>)}
          </ol>
        </Section>
      )}
      {blueprints.length > 0 && (
        <Section title="Message blueprints">
          {blueprints.map((b, i) => (
            <div key={i} className="border border-slate-100 dark:border-slate-800 rounded-lg p-2">
              <div className="text-xs font-semibold">{String(b.blueprint_name)} <span className="font-normal text-slate-400 dark:text-slate-500">— use when: {String(b.use_when)}</span></div>
              <pre className="mt-1 text-xs whitespace-pre-wrap font-sans text-slate-600 dark:text-slate-400">{String(b.template)}</pre>
            </div>
          ))}
        </Section>
      )}
      {friction.length > 0 && (
        <Section title="Friction risks (from persona stage)">
          <ul className="list-disc ml-4 text-xs space-y-1">
            {friction.slice(0, 5).map((f, i) => (
              <li key={i}><strong>{String(f.risk)}</strong> — mitigation: {((f.mitigation as string[]) ?? []).join("; ")}</li>
            ))}
          </ul>
        </Section>
      )}
      {levers.length > 0 && (
        <Section title="Rapport levers">
          <ul className="list-disc ml-4 text-xs space-y-1">
            {levers.slice(0, 5).map((l, i) => (
              <li key={i}><strong>{String(l.lever)}</strong> — {String(l.safe_usage_note)}</li>
            ))}
          </ul>
        </Section>
      )}
      {interp.length > 0 && (
        <Section title="How to read their responses">
          <ul className="list-disc ml-4 text-xs space-y-1">
            {interp.slice(0, 5).map((r, i) => (
              <li key={i}><strong>{r.observed_response_type}:</strong> {r.bounded_interpretation} → {r.recommended_next_step}</li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
