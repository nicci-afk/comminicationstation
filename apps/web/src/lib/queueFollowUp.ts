import type { QueueItem } from "./types";

// This one normalization is performed by canonical migration 0006. Accept its
// returned state, never an arbitrary different state or an incomplete receipt.
export function queueActionConfirmed(id: string, patch: Partial<QueueItem>, saved: QueueItem | null): boolean {
  if (!saved || saved.id !== id) return false;
  const awaitingAfterResponse = patch.state === "responded" && saved.state === "awaiting_reply"
    && ["needs_reply", "urgent", "scheduling"].includes(saved.category)
    && saved.follow_up_at !== null && Number.isFinite(Date.parse(saved.follow_up_at));
  return Object.entries(patch).every(([key, value]) => {
    if (key === "state" && awaitingAfterResponse) return true;
    const actual = saved[key as keyof QueueItem];
    if (key.endsWith("_at") || key === "snoozed_until") {
      return value === null ? actual === null
        : Number.isFinite(Date.parse(String(value))) && Date.parse(String(actual)) === Date.parse(String(value));
    }
    return actual === value;
  });
}

// The field is explicitly labeled UTC: no natural-language/date inference,
// browser timezone conversion, default deadline, or client promise is added.
export function explicitFollowUpUtc(value: string, now = Date.now()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 16) !== value || date.getTime() <= now) return null;
  return date.toISOString();
}

export function followUpLabel(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "No follow-up date recorded";
  return `${Date.parse(value) <= Date.now() ? "Follow-up due" : "Follow-up scheduled"}: ${new Date(value).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}
