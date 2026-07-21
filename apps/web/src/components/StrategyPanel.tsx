// Renders the stored claude_comm_output_v1 strategy for the item's contact —
// the packet the user acts on. Zone-colored; red zone shows escalation only.
import { Link } from "react-router-dom";
import type { ContactStrategy, QueueItem } from "../lib/types";

const ZONE_STYLE = {
  green: "bg-emerald-50 border-emerald-200 text-emerald-900",
  yellow: "bg-amber-50 border-amber-200 text-amber-900",
  red: "bg-red-50 border-red-200 text-red-900",
} as const;

export default function StrategyPanel({
  item,
  strategy,
  comm,
}: {
  item: QueueItem;
  strategy: ContactStrategy | null;
  comm: Record<string, unknown> | null;
}) {
  if (!item.contact_id) return null;
  if (!strategy) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <h3 className="text-sm font-semibold">Communication strategy</h3>
        <p className="mt-1 text-xs text-slate-500">
          No stored strategy for this contact yet. The full analysis pipeline runs only when you ask.
        </p>
        <Link
          to={`/contacts/${item.contact_id}`}
          className="mt-2 inline-block text-sm text-indigo-600 hover:underline"
        >
          Analyze contact →
        </Link>
      </div>
    );
  }

  const tone = comm?.tone_profile as { recommended_tone?: string[]; avoid_tone?: string[] } | undefined;
  const openings = (comm?.opening_options as { option: string; use_when: string }[]) ?? [];
  const langDo = (comm?.language_do as string[]) ?? [];
  const langAvoid = (comm?.language_avoid as string[]) ?? [];

  return (
    <div className={`border rounded-xl p-4 ${ZONE_STYLE[strategy.allowed_zone]}`}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Communication strategy</h3>
        <span className="text-xs uppercase font-bold">{strategy.allowed_zone} zone</span>
      </div>
      {strategy.re_analysis_recommended && (
        <div className="mt-2 text-xs bg-white/70 rounded-lg p-2">
          🔁 Re-analysis recommended: {strategy.re_analysis_reason}.{" "}
          <Link to={`/contacts/${strategy.contact_id}`} className="underline">Review</Link>
        </div>
      )}
      {strategy.allowed_zone === "red" ? (
        <p className="mt-2 text-xs">
          Evidence for this contact is red-band — do not operationalize. Review the analysis before
          relying on any strategy. <Link to={`/contacts/${strategy.contact_id}`} className="underline">Open analysis</Link>
        </p>
      ) : comm ? (
        <div className="mt-2 space-y-2 text-xs">
          {typeof comm.recommended_approach === "string" && (
            <p><strong>Approach:</strong> {comm.recommended_approach}</p>
          )}
          {tone?.recommended_tone && tone.recommended_tone.length > 0 && (
            <p><strong>Tone:</strong> {tone.recommended_tone.join(", ")}
              {tone.avoid_tone?.length ? ` — avoid ${tone.avoid_tone.join(", ")}` : ""}</p>
          )}
          {openings.length > 0 && (
            <p><strong>Opening:</strong> “{openings[0].option}”</p>
          )}
          {langDo.length > 0 && <p><strong>Do:</strong> {langDo.slice(0, 4).join(" · ")}</p>}
          {langAvoid.length > 0 && <p><strong>Avoid:</strong> {langAvoid.slice(0, 4).join(" · ")}</p>}
          <Link to={`/contacts/${strategy.contact_id}`} className="inline-block underline">
            Full strategy →
          </Link>
        </div>
      ) : (
        <p className="mt-2 text-xs">Loading strategy…</p>
      )}
    </div>
  );
}
