import type { MccTodayItem } from "./types";

// Retain the database's deterministic ordering. Section alone is not eligibility:
// urgent conflicts and overdue waiting records can appear in attention sections.
export function focusEligible(item: MccTodayItem): boolean {
  return ["NEEDS_YOU_NOW", "NEXT"].includes(item.section)
    && item.execution_owner === "NICCI"
    && !["WAITING", "BLOCKED", "SOMEDAY", "DONE", "CANCELLED"].includes(item.state)
    && !item.has_open_dependency && !item.is_stale
    && ["VERIFIED", "PARTIALLY_VERIFIED"].includes(item.verification_state)
    && !!item.next_action?.trim();
}
export function selectFocus(items: MccTodayItem[]): MccTodayItem | null {
  return items.find(focusEligible) ?? null;
}
export function dailyItems(items: MccTodayItem[], expanded = false): MccTodayItem[] {
  const counts = new Map<string, number>();
  return items.filter(item => {
    const count = (counts.get(item.section) ?? 0) + 1;
    counts.set(item.section, count);
    // Urgent exceptions never disappear behind the summary limit.
    return expanded || item.critical_attention || count <= (item.section === "NEXT" ? 5 : 3);
  });
}
