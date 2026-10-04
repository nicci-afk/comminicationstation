import { useEffect, useRef, useState } from "react";
import { api } from "../lib/supabase";
import { detectReplyRisks, type Check, type Claim, type Evidence, type Draft } from "../lib/replyEvidence";
type Source = {
    direction?: "inbound" | "outbound";
    bodyMissing?: boolean;
    id: string;
    hash: string;
    text: string | null;
    sentAt: string;
    contactId: string;
};
type State = {
    draft: Draft;
    claims: Claim[];
    sources: Source[];
    evidence: Evidence[];
    evidenceRead: {
        complete: boolean;
        revision: string;
        unresolvedOutboundCount?: number;
    };
    dispatch_enabled?: boolean;
};
type Checked = {
    check_id: string;
    check: Check;
    state: State;
    expires_at: string;
    dispatch_enabled: boolean;
};
type Approval = {
    approval_id: string;
    expires_at: string;
};
type Delivery = {
    id?: string;
    dispatch_id?: string;
    approval_id?: string;
    status: string;
    ingestion_pending?: boolean;
    audit_pending?: boolean;
    error?: string;
};
export default function ReplyReview({ itemId, channel, initialDraft, onSent }: {
    itemId: string;
    channel: "email" | "sms" | "whatsapp";
    initialDraft?: {
        itemId: string;
        id: string;
        text: string;
        revision: number;
    } | null;
    onSent: () => void;
}) {
    const scopedDraft = initialDraft?.itemId === itemId ? initialDraft : null;
    const [text, setText] = useState("");
    const [state, setState] = useState<State | null>(null);
    const [claimRows, setClaimRows] = useState<Claim[]>([]);
    const [checked, setChecked] = useState<Checked | null>(null);
    const [approved, setApproved] = useState<Approval | null>(null);
    const [reviewed, setReviewed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [delivery, setDelivery] = useState<Delivery | null>(null);
    const [customQuote, setCustomQuote] = useState("");
    const [customKind, setCustomKind] = useState<Claim["kind"]>("commitment");
    const draftId = useRef<string>(crypto.randomUUID());
    const revision = useRef(0);
    const version = useRef(0);
    const locked = useRef(false);
    const sentNotified = useRef(false);
    const sourceDisclosure = useRef<HTMLDetailsElement>(null);
    const styles = "rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-950 p-2 text-sm w-full";
    function invalidate() { version.current++; setChecked(null); setApproved(null); setReviewed(false); setError(""); }
    useEffect(() => { version.current++; draftId.current = scopedDraft?.id ?? crypto.randomUUID(); revision.current = scopedDraft?.revision ?? 0; setText(scopedDraft?.text ?? ""); setClaimRows([]); setState(null); setChecked(null); setApproved(null); setReviewed(false); setDelivery(null); sentNotified.current = false; }, [itemId, scopedDraft?.id]);
    useEffect(() => () => { version.current++; }, []);
    useEffect(() => { if (!approved)
        return; const timer = setTimeout(() => { setApproved(null); setReviewed(false); setError("Approval expired. Check and review the current reply again."); }, Math.max(0, Date.parse(approved.expires_at) - Date.now())); return () => clearTimeout(timer); }, [approved]);
    function changeText(value: string) { invalidate(); setText(value); setClaimRows([]); }
    async function run(work: (ticket: number) => Promise<void>) { if (locked.current)
        return; locked.current = true; setBusy(true); setError(""); const ticket = version.current; try {
        await work(ticket);
    }
    catch (e) {
        if (ticket === version.current) {
            setError((e as Error).message);
            setApproved(null);
            setReviewed(false);
        }
    }
    finally {
        locked.current = false;
        setBusy(false);
    } }
    function normalizeRows(body: string) { return claimRows.length ? claimRows : detectReplyRisks(body).map((risk, i) => ({ id: `claim-${i}`, kind: risk.kind, start: risk.start, end: risk.end, quote: risk.text, factKey: `item:${itemId}:${risk.kind}:${i}`, value: "UNREVIEWED", evidenceIds: [] })); }
    async function saveAndCheck(ticket: number) {
        const body = text.trim();
        const rows = normalizeRows(body);
        const saved = await api<State>("reply-review", { operation: "SAVE", queue_item_id: itemId, draft_id: draftId.current, revision: revision.current, text: body, claims: rows });
        // Keep committed revision even if the user edited during this request; never resurrect its check.
        if (saved.draft.id === draftId.current)
            revision.current = saved.draft.revision;
        if (ticket !== version.current)
            return;
        setState(saved);
        setText(saved.draft.text);
        setClaimRows(saved.claims);
        const next = await api<Checked>("reply-review", { operation: "CHECK", draft_id: draftId.current });
        if (ticket === version.current) {
            setChecked(next);
            setState(next.state);
            setApproved(null);
            setReviewed(false);
        }
    }
    function changeClaim(index: number, patch: Partial<Claim>) { invalidate(); setClaimRows(rows => rows.map((r, i) => i === index ? { ...r, ...patch, evidenceIds: [] } : r)); }
    function addClaim() { const at = text.indexOf(customQuote); if (!customQuote.trim() || at < 0) {
        setError("Select an exact phrase from this reply");
        return;
    } invalidate(); setClaimRows(rows => [...rows, { id: crypto.randomUUID(), kind: customKind, start: at, end: at + customQuote.length, quote: customQuote, factKey: `item:${itemId}:custom`, value: "UNREVIEWED", evidenceIds: [] }]); setCustomQuote(""); }
    async function verify(index: number, source: Source, excerpt: string, until: string, supersedes: string[]) {
        invalidate();
        await run(async (ticket) => {
            // Persist the exact claim mapping before recording evidence against its revision.
            const saved = await api<State>("reply-review", { operation: "SAVE", queue_item_id: itemId, draft_id: draftId.current, revision: revision.current, text: text.trim(), claims: claimRows });
            if (saved.draft.id === draftId.current)
                revision.current = saved.draft.revision;
            if (ticket !== version.current)
                return;
            const row = claimRows[index];
            const start = source.text?.indexOf(excerpt) ?? -1;
            if (start < 0 || !excerpt.trim())
                throw new Error("The excerpt must match the selected source exactly");
            const evidence = await api<{
                evidence_id: string;
                state: State;
            }>("reply-review", { operation: "EVIDENCE", draft_id: draftId.current, revision: revision.current, message_id: source.id, source_hash: source.hash, kind: row.kind, fact_key: row.factKey, value: row.value, start, end: start + excerpt.length, excerpt, valid_until: until, reviewed: true, supersedes });
            if (ticket !== version.current)
                return;
            const rows = claimRows.map((r, i) => i === index ? { ...r, evidenceIds: [evidence.evidence_id] } : r);
            const linked = await api<State>("reply-review", { operation: "SAVE", queue_item_id: itemId, draft_id: draftId.current, revision: revision.current, text: text.trim(), claims: rows });
            if (linked.draft.id === draftId.current)
                revision.current = linked.draft.revision;
            if (ticket === version.current) {
                setState(linked);
                setClaimRows(rows);
                setChecked(null);
            }
        });
    }
    const approvedNow = approved && Date.parse(approved.expires_at) > Date.now();
    return <section aria-label="Evidence-backed reply" className="mt-4 rounded-xl border border-slate-200 dark:border-slate-700 p-4 bg-white dark:bg-slate-900 space-y-3">
  <h2 className="font-semibold">Review reply and evidence</h2>
  <p className="text-xs text-slate-500">Source support is not a guarantee of truth. Review every material claim, condition and recipient. Editing clears approval.</p>
  <textarea aria-label="Reply text" value={text} onChange={e => changeText(e.target.value)} rows={5} className={styles} disabled={!!delivery}/>
  <button disabled={busy || !text.trim() || !!delivery} onClick={() => run(saveAndCheck)} className="rounded bg-indigo-600 text-white px-3 py-2 disabled:opacity-50">{busy ? "Working…" : "Save and check evidence"}</button>
  {state && <>
   <p className="text-sm">From {state.draft.transport?.from} → {state.draft.recipients.join(", ")} · {state.draft.channel}</p>
   {state.draft.subject && <p className="text-sm">Subject: {state.draft.subject}</p>}
   {!state.evidenceRead.complete && <p role="alert" className="text-amber-700">Source review is incomplete. Missing full messages, unresolved client scope or a source limit blocks approval.</p>}
   {!!state.evidenceRead.unresolvedOutboundCount && <p role="alert" className="text-sm text-amber-700">Some sent messages don't have a verifiable single-recipient delivery record. They are excluded as evidence, so full-context review remains incomplete and this reply is blocked here.</p>}
   {channel === "email" && state.sources.some(s => s.bodyMissing) && <button disabled={busy || !!delivery} className="rounded border px-3 py-2 text-sm disabled:opacity-50" onClick={() => { invalidate(); run(async (ticket) => { const missing = state.sources.filter(s => s.bodyMissing).slice(0, 20); for (const source of missing) {
            await api("gmail-get-body", { message_id: source.id });
            if (ticket !== version.current)
                return;
        } const next = await api<State>("reply-review", { operation: "SNAPSHOT", draft_id: draftId.current }); if (ticket === version.current)
            setState(next); }); }}>Load next {Math.min(20, state.sources.filter(s => s.bodyMissing).length)} missing source bodies</button>}
   <details ref={sourceDisclosure}><summary className="cursor-pointer text-sm">Review all {state.sources.length} eligible source messages</summary>{state.sources.map(s => <article key={s.id} id={`reply-source-${s.id}`} tabIndex={-1} className="mt-2 border-l-2 pl-3"><p className="text-xs">{s.direction === "outbound" ? "Your prior outbound message; not supplier confirmation" : "Incoming message"} · {new Date(s.sentAt).toLocaleString()}</p><pre className="text-xs whitespace-pre-wrap font-sans">{s.text ?? "Full source unavailable"}</pre></article>)}</details>
   {state.evidence.length > 0 && <details><summary className="cursor-pointer text-sm">Manage recorded evidence</summary>{state.evidence.filter(e => !e.revoked).map(e => <div key={e.id} className="text-xs my-2"><span>{e.factKey}: {e.value}</span> <button disabled={busy || !!delivery} className="underline" onClick={() => { invalidate(); run(async (ticket) => { const next = await api<State>("reply-review", { operation: "REVOKE", draft_id: draftId.current, revision: revision.current, evidence_id: e.id }); if (ticket === version.current) {
            setState(next);
            setClaimRows(rows => rows.map(r => ({ ...r, evidenceIds: r.evidenceIds.filter(id => id !== e.id) })));
        } }); }}>Revoke this evidence</button></div>)}</details>}
   {claimRows.map((row, index) => <ClaimReview key={row.id} row={row} index={index} state={state} busy={busy || !!delivery} styles={styles} change={patch => changeClaim(index, patch)} verify={(source, excerpt, until, supersedes) => verify(index, source, excerpt, until, supersedes)}/>)}
   <details><summary className="cursor-pointer text-sm">Add a claim the check missed</summary><div className="space-y-2 mt-2"><input aria-label="Additional claim phrase" className={styles} value={customQuote} onChange={e => setCustomQuote(e.target.value)} placeholder="Exact phrase from reply"/><select aria-label="Additional claim type" className={styles} value={customKind} onChange={e => setCustomKind(e.target.value as Claim["kind"])}><option value="price">Price</option><option value="date">Date</option><option value="commitment">Commitment</option></select><button disabled={busy || !!delivery} onClick={addClaim}>Add claim</button></div></details>
  </>}
  {checked && <div className="rounded border p-3 space-y-2">
   <p className="font-medium">{checked.check.status === "BLOCKED" ? "Resolve evidence issues before approval" : "Sources support the mapped claims; full review still required"}</p>
   {checked.check.issues.map((issue, i) => <p key={i} className="text-sm text-amber-700">{issue.claimId ? `${issue.claimId}: ` : ""}{issue.code.replaceAll("_", " ").toLowerCase()}</p>)}
   {checked.check.claims.map(c => <div key={c.id}>{c.citations.map(e => <p key={e.evidenceId} className="text-xs"><a className="underline" href={e.locator} onClick={event => { event.preventDefault(); if (sourceDisclosure.current) {
            sourceDisclosure.current.open = true;
            const target = sourceDisclosure.current.querySelector<HTMLElement>(`#reply-source-${e.sourceId}`);
            target?.focus();
            target?.scrollIntoView({ block: "nearest" });
        } }}>View source</a> · {e.direction === "outbound" ? "Your prior outbound message; not supplier confirmation" : "Incoming source"} · {new Date(e.sourceDate).toLocaleString()} · valid until {new Date(e.validUntil).toLocaleString()}<br />{e.excerpt}</p>)}</div>)}
   {checked.check.status !== "BLOCKED" && <>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={reviewed} disabled={busy || !!delivery} onChange={e => { setReviewed(e.target.checked); setApproved(null); }}/>I reviewed the entire reply, recipient and complete source context, including conditions and claims the pattern check may have missed</label>
    <button disabled={busy || !reviewed || !!delivery} onClick={() => run(async (ticket) => { const a = await api<Approval>("reply-review", { operation: "APPROVE", check_id: checked.check_id, snapshot_key: checked.check.snapshotKey, review_key: checked.check.reviewKey, coverage_reviewed: true }); if (ticket === version.current)
                setApproved(a); })} className="rounded border px-3 py-2 disabled:opacity-50">Approve this exact reply</button>
   </>}
  </div>}
  {approved && <p className="text-sm">Approval expires at {new Date(approved.expires_at).toLocaleTimeString()}</p>}
  {checked && !checked.dispatch_enabled && <p className="text-sm text-amber-700">Sending is disabled in this environment. Review and approval can still be tested.</p>}
  <button disabled={busy || !approvedNow || !checked?.dispatch_enabled || !!delivery} onClick={() => run(async (ticket) => {
            const approvalId = approved!.approval_id;
            setDelivery({ status: "SENDING", approval_id: approvalId });
            setApproved(null);
            let result: Delivery;
            try {
                result = await api<Delivery>(channel === "email" ? "gmail-send" : "twilio-send", { approval_id: approvalId, channel });
            }
            catch {
                result = { status: "UNKNOWN", approval_id: approvalId, error: "The send response was interrupted. Check delivery status; do not create another send." };
            }
            if (ticket !== version.current)
                return;
            setDelivery({ ...result, approval_id: approvalId });
            setApproved(null);
            if (result.status === "SENT" && !sentNotified.current) {
                sentNotified.current = true;
                onSent();
            }
        })} className="rounded bg-emerald-700 text-white px-4 py-2 disabled:opacity-50">Send approved reply</button>
  {delivery && <div role="status"><p>Delivery: {delivery.status.toLowerCase()}</p>{delivery.error && <p>{delivery.error}</p>}{delivery.status === "RESERVED" && delivery.dispatch_id && <button disabled={busy} onClick={() => run(async () => setDelivery(await api<Delivery>("reply-review", { operation: "CANCEL", dispatch_id: delivery.dispatch_id })))}>Cancel pending send</button>}{delivery.ingestion_pending && <p>Message sent; the conversation record still needs reconciliation</p>}{(delivery.dispatch_id || delivery.approval_id) && <button disabled={busy} onClick={() => run(async () => { const result = await api<Delivery>("reply-review", { operation: "STATUS", ...(delivery.dispatch_id ? { dispatch_id: delivery.dispatch_id } : { approval_id: delivery.approval_id }) }); setDelivery({ ...delivery, ...result, dispatch_id: result.dispatch_id ?? result.id ?? delivery.dispatch_id } as Delivery); })}>Check delivery status</button>}</div>}
  {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
 </section>;
}
function ClaimReview({ row, index, state, busy, styles, change, verify }: {
    row: Claim;
    index: number;
    state: State;
    busy: boolean;
    styles: string;
    change: (patch: Partial<Claim>) => void;
    verify: (source: Source, excerpt: string, until: string, supersedes: string[]) => Promise<void>;
}) {
    const [sourceId, setSourceId] = useState("");
    const [excerpt, setExcerpt] = useState("");
    const [validity, setValidity] = useState("1");
    const [attested, setAttested] = useState(false);
    const [replace, setReplace] = useState<string[]>([]);
    const source = state.sources.find(s => s.id === sourceId);
    useEffect(() => setAttested(false), [sourceId, excerpt, validity, row.factKey, row.value]);
    return <fieldset className="min-w-0 border rounded p-3 space-y-2" disabled={busy}><legend className="text-sm font-medium">{index + 1}. {row.kind}: {row.quote}</legend>
  <label className="block text-xs">Fact identity, including quote/booking/transaction<input aria-label={`Fact key ${index + 1}`} value={row.factKey} onChange={e => change({ factKey: e.target.value })} className={styles}/></label>
  <label className="block text-xs">Exact canonical value (for example USD:125000 or date with timezone)<input aria-label={`Claim value ${index + 1}`} value={row.value} onChange={e => change({ value: e.target.value })} className={styles}/></label>
  <select aria-label={`Source ${index + 1}`} className={styles} value={sourceId} onChange={e => setSourceId(e.target.value)}><option value="">Select a source you reviewed</option>{state.sources.filter(s => s.text !== null).map(s => <option key={s.id} value={s.id}>{s.direction === "outbound" ? "Your prior outbound" : "Incoming"} · {new Date(s.sentAt).toLocaleString()} · {s.text?.slice(0, 90)}</option>)}</select>
  {source && <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-sans text-xs">{source.text}</pre>}
  <textarea aria-label={`Source excerpt ${index + 1}`} className={styles} value={excerpt} onChange={e => setExcerpt(e.target.value)} placeholder="Paste the exact supporting excerpt" rows={2}/>
  <label className="text-xs block">Valid for <select aria-label={`Evidence validity ${index + 1}`} value={validity} onChange={e => setValidity(e.target.value)}><option value="0.0166666667">1 minute</option><option value="0.0833333333">5 minutes</option><option value="0.25">15 minutes</option><option value="1">1 hour</option><option value="4">4 hours</option><option value="24">24 hours</option></select> from this verification. Use the source's shorter actual validity.</label>
  {state.evidence.filter(e => e.factKey === row.factKey && e.kind === row.kind && !e.revoked).map(e => <label className="block text-xs" key={e.id}><input type="checkbox" checked={replace.includes(e.id)} onChange={v => { setAttested(false); setReplace(old => v.target.checked ? [...old, e.id] : old.filter(id => id !== e.id)); }}/>This later source explicitly replaces {e.value} ({new Date(e.source.occurredAt).toLocaleString()})</label>)}
  <label className="flex gap-2 text-xs"><input type="checkbox" checked={attested} onChange={e => setAttested(e.target.checked)}/>I verified this source supports this exact claim, client, transaction and validity, including any conditions. A matching phrase alone is insufficient.</label>
  <button disabled={!source || !excerpt.trim() || !attested || row.value === "UNREVIEWED" || !row.value.trim() || !row.factKey.trim()} onClick={() => source && verify(source, excerpt, new Date(Date.now() + Number(validity) * 3600000).toISOString(), replace)} className="rounded border px-3 py-2 text-sm disabled:opacity-50">Record reviewed evidence</button>
  {row.evidenceIds.length > 0 && <p className="text-xs text-emerald-700">Evidence linked. Save and check again before approval.</p>}
 </fieldset>;
}
