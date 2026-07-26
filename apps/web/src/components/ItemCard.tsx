import { Link } from "react-router-dom";
import { AlertTriangle, Mail, MessageSquare, Phone, Star } from "lucide-react";
import type { Business, QueueItem } from "../lib/types";
import { fmtWhen } from "../lib/hooks";

const CHANNEL_ICON = { email: Mail, sms: Phone, whatsapp: MessageSquare } as const;

export const CATEGORY_STYLE: Record<string, string> = {
  needs_reply: "bg-amber-100 text-amber-800",
  urgent: "bg-red-100 text-red-800",
  scheduling: "bg-sky-100 text-sky-800",
  promotion: "bg-slate-100 text-slate-500",
  newsletter: "bg-slate-100 text-slate-500",
  notification: "bg-slate-100 text-slate-500",
  receipt: "bg-emerald-50 text-emerald-700",
  expense: "bg-emerald-50 text-emerald-700",
  fyi: "bg-slate-100 text-slate-600",
  other: "bg-slate-100 text-slate-600",
  // travel categories
  booking: "bg-blue-100 text-blue-800",
  bdm: "bg-violet-100 text-violet-800",
  possible_supplier: "bg-violet-50 text-violet-700",
  // real estate categories
  lead: "bg-rose-100 text-rose-800",
  agent_to_agent: "bg-orange-100 text-orange-800",
  lender: "bg-orange-50 text-orange-700",
  title: "bg-orange-50 text-orange-700",
};

export function BusinessChip({ businesses, id }: { businesses: Business[]; id: string | null }) {
  const b = businesses.find((x) => x.id === id);
  if (!b) return null;
  return (
    <span
      className="px-2 py-0.5 rounded-full text-xs font-medium text-white"
      style={{ backgroundColor: b.color }}
    >
      {b.name}
    </span>
  );
}

export default function ItemCard({
  item,
  businesses,
  selected,
}: {
  item: QueueItem;
  businesses: Business[];
  selected?: boolean;
}) {
  const Icon = CHANNEL_ICON[item.channel] ?? Mail;
  return (
    <Link
      to={`/item/${item.id}`}
      className={`block bg-white border rounded-xl px-4 py-3 transition hover:border-indigo-300 hover:shadow-sm ${
        selected ? "border-indigo-500 ring-2 ring-indigo-100" : "border-slate-200"
      }`}
    >
      <div className="flex items-center gap-2 text-sm">
        <Icon className="w-4 h-4 text-slate-400 shrink-0" />
        {item.is_vip && <Star className="w-4 h-4 text-amber-500 shrink-0" fill="currentColor" />}
        {item.escalated && <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />}
        <span className="font-semibold truncate">{item.sender_name || item.sender_identifier}</span>
        <span className={`px-2 py-0.5 rounded-full text-xs ${CATEGORY_STYLE[item.category] ?? CATEGORY_STYLE.other}`}>
          {item.category.replace("_", " ")}
        </span>
        <BusinessChip businesses={businesses} id={item.business_id} />
        <span className="ml-auto text-xs text-slate-400 shrink-0">{fmtWhen(item.created_at)}</span>
        <span className="text-xs font-mono text-slate-400 shrink-0 w-7 text-right">{item.priority}</span>
      </div>
      <div className="mt-1 text-sm text-slate-700 truncate">{item.title || "(no subject)"}</div>
      <div className="text-xs text-slate-400 truncate">{item.preview}</div>
      {item.state === "awaiting_reply" && (
        <div className="mt-1 text-xs text-sky-600">⏳ awaiting their reply · nudge resurfaces {fmtWhen(item.follow_up_at)}</div>
      )}
    </Link>
  );
}
