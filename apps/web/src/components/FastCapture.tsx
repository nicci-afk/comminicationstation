import { useRef, useState } from "react";
import { useMccCapture, useMccCaptures, useMccProjects } from "../lib/hooks";

export default function FastCapture() {
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const request = useRef<{ id: string; note: string } | null>(null);
  const capture = useMccCapture();
  const { data: captures = [], error, isLoading } = useMccCaptures();
  async function save() {
    if (!note.trim() || capture.isPending) return;
    // Reuse the same key after a timeout; editing creates a new intentional capture.
    if (!request.current || request.current.note !== note) request.current = { id: crypto.randomUUID(), note };
    setMessage("");
    try {
      const result = await capture.mutateAsync({ operation: "CAPTURE", request_id: request.current.id, note });
      if (!result.ok || !result.obligation_id) throw new Error("Save was not confirmed. Keep the note and retry.");
      setNote(""); request.current = null;
      setMessage("Captured. Review when ready.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "Save unconfirmed. Keep the note and retry."); }
  }
  return <section className="mt-6 rounded-2xl border border-slate-200 dark:border-slate-700 p-4">
    <label htmlFor="fast-capture" className="font-semibold">What's on your mind?</label>
    <textarea id="fast-capture" value={note} maxLength={10000} disabled={capture.isPending}
      onChange={e => setNote(e.target.value)} rows={2} placeholder="Type, paste, or use your device's dictation…"
      onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void save(); } }}
      className="mt-2 block w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent p-3" />
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <button type="button" onClick={save} disabled={!note.trim() || capture.isPending}
        className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white disabled:opacity-50">{capture.isPending ? "Saving…" : "Capture"}</button>
      <button type="button" onClick={() => setReviewOpen(v => !v)} className="text-sm underline">
        {error ? "Capture inbox unavailable" : isLoading ? "Loading captures…" : `Review captures (${captures.length})`}
      </button>
    </div>
    <p role="status" className="mt-2 text-sm">{message}</p>
    {error && <p role="alert" className="text-sm text-red-600">Capture inbox unavailable. Its count is unconfirmed.</p>}
    {reviewOpen && !error && <div className="mt-3 space-y-3">{captures.map(item => <CaptureReview key={item.id} item={item} />)}
      {!isLoading && captures.length === 0 && <p className="text-sm text-slate-500">No captures awaiting review.</p>}
    </div>}
  </section>;
}
function CaptureReview({ item }: { item: { id: string; title: string; description: string | null } }) {
  const [nextAction, setNextAction] = useState("");
  const [project, setProject] = useState("");
  const [error, setError] = useState("");
  const review = useMccCapture();
  const { data: projects = [], error: projectError } = useMccProjects();
  async function confirm() {
    setError("");
    try { await review.mutateAsync({ operation: "REVIEW", obligation_id: item.id, next_action: nextAction, project_id: project || null }); }
    catch (e) { setError(e instanceof Error ? e.message : "Review unconfirmed."); }
  }
  return <div className="rounded-xl bg-slate-50 dark:bg-slate-800 p-3">
    <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">Captured — needs clarification</p>
    <p className="my-2 whitespace-pre-wrap text-sm">{item.description ?? item.title}</p>
    <label className="block text-sm">Confirm one next action
      <input value={nextAction} onChange={e => setNextAction(e.target.value)} maxLength={2000} disabled={review.isPending}
        className="mt-1 block w-full rounded-lg border bg-transparent p-2" />
    </label>
    <label className="mt-2 block text-sm">Project (optional)
      <select value={project} onChange={e => setProject(e.target.value)} disabled={review.isPending || !!projectError} className="mt-1 block w-full rounded-lg border bg-white dark:bg-slate-900 p-2">
        <option value="">Needs project matching</option>{projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
      </select>
    </label>
    {projectError && <p className="text-sm text-red-600">Projects unavailable. You can confirm the action without assigning one.</p>}
    <button type="button" onClick={confirm} disabled={!nextAction.trim() || review.isPending} className="mt-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white disabled:opacity-50">Add to today's actions</button>
    <p className="mt-2 text-xs text-slate-500">Confirms your intended action. Booking, payment and supplier facts still need verification.</p>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
  </div>;
}
