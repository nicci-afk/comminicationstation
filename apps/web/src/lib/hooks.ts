import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, supabase } from "./supabase";
import { queueActionConfirmed } from "./queueFollowUp";
import type {
  Business,
  Contact,
  ContactChannel,
  ContactStrategy,
  MccTodayItem,
  Message,
  MccIntegrityStatus,
  ObligationSource,
  ObligationEvent,
  MccManualActionInput,
  ProductionChangeReceipt,
  Profile,
  QueueEvent,
  QueueItem,
} from "./types";

export function useProfile() {
  return useQuery({
    queryKey: ["profile"],
    queryFn: async (): Promise<Profile | null> => {
      const { data, error } = await supabase.from("profiles").select("*").maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useBusinesses() {
  return useQuery({
    queryKey: ["businesses"],
    queryFn: async (): Promise<Business[]> => {
      const { data, error } = await supabase.from("businesses").select("*").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useQueue(states: string[], businessId?: string | null, page = 0) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ["queue", states, businessId ?? "all", page],
    queryFn: async ({ signal }): Promise<{ items: QueueItem[]; total: number; page: number }> => {
      async function readPage(index: number) {
        let q = supabase.from("queue_items").select("*", { count: "exact" }).in("state", states);
        if (businessId) q = q.eq("business_id", businessId);
        // Open follow-ups are date-first; undated items remain reachable.
        if (states.length === 1 && states[0] === "awaiting_reply") q = q.order("follow_up_at", { ascending: true, nullsFirst: false });
        const { data, error, count } = await q.order("priority", { ascending: false })
          .order("created_at", { ascending: false }).order("id", { ascending: true })
          .range(index * TODAY_PAGE_SIZE, (index + 1) * TODAY_PAGE_SIZE - 1).abortSignal(signal);
        if (error) throw error;
        if (!Array.isArray(data) || count === null || count < 0 || data.length !== Math.max(0, Math.min(TODAY_PAGE_SIZE, count - index * TODAY_PAGE_SIZE))) {
          throw new Error("Queue response was incomplete. Refresh to verify it.");
        }
        return { items: data as QueueItem[], total: count, page: index };
      }
      try { return await readPage(page); }
      catch (error) {
        if (page === 0 || (error as { code?: string }).code !== "PGRST103") throw error;
        const first = await readPage(0);
        qc.setQueryData(["queue", states, businessId ?? "all", 0], first);
        return first;
      }
    },
    staleTime: query => query.state.data?.page === page ? 60_000 : 0,
  });
}

export const TODAY_PAGE_SIZE = 200;
export function useTodayQueue(page: number) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ["queue-page", "today", page],
    queryFn: async ({ signal }): Promise<{ items: QueueItem[]; total: number; page: number }> => {
      async function readPage(index: number) {
        const response = await supabase.from("queue_items")
          .select("*", { count: "exact" }).eq("state", "needs_attention")
          .order("priority", { ascending: false }).order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(index * TODAY_PAGE_SIZE, (index + 1) * TODAY_PAGE_SIZE - 1).abortSignal(signal);
        const { data, error, count } = response;
        if (error) throw error;
        if (!Array.isArray(data) || count === null || count < 0 || data.length !== Math.max(0, Math.min(TODAY_PAGE_SIZE, count - index * TODAY_PAGE_SIZE))) {
          throw new Error("Queue response was incomplete. Refresh to verify it.");
        }
        return { items: data as QueueItem[], total: count, page: index };
      }
      try { return await readPage(page); }
      catch (error) {
        // PostgREST reports an offset beyond the remaining rows as PGRST103
        // (HTTP 416), not a successful empty page. Only a fresh first-page
        // response may supply the new count or prove the queue is empty.
        if (page === 0 || (error as { code?: string }).code !== "PGRST103") throw error;
        const first = await readPage(0);
        qc.setQueryData(["queue-page", "today", 0], first);
        return first;
      }
    },
    // A recovered first page is not a reusable snapshot of the old page key.
    staleTime: query => query.state.data?.page === page ? 60_000 : 0,
  });
}

// Realtime as cache invalidation: any change to my queue rows refetches the
// visible page through RLS. Falls back gracefully — a 60s poll keeps things
// fresh if the socket drops.
export function useQueueRealtime() {
  const qc = useQueryClient();
  useEffect(() => {
    const channel = supabase
      .channel("queue-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "queue_items" }, () => {
        qc.invalidateQueries({ queryKey: ["queue"] });
        qc.invalidateQueries({ queryKey: ["queue-page"] });
      })
      .subscribe();
    const interval = setInterval(() => {
      qc.invalidateQueries({ queryKey: ["queue"] });
      qc.invalidateQueries({ queryKey: ["queue-page"] });
    }, 60_000);
    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, [qc]);
}

export function useMccToday() {
  return useQuery({
    queryKey: ["mcc-today"],
    queryFn: async (): Promise<MccTodayItem[]> => {
      const { data, error } = await supabase
        .from("mcc_today")
        .select("*")
        .order("section_order", { ascending: true })
        .order("section_rank", { ascending: true });
      if (error) throw error;
      return (data ?? []) as MccTodayItem[];
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useObligationSources(obligationId: string | null) {
  return useQuery({
    queryKey: ["obligation-sources", obligationId],
    enabled: !!obligationId,
    queryFn: async (): Promise<ObligationSource[]> => {
      const { data, error } = await supabase
        .from("obligation_sources")
        .select("id,obligation_id,source_system,source_type,source_ref,source_url,source_timestamp,content_hash,claim_scope,authoritative_claims,evidence_role,created_at")
        .eq("obligation_id", obligationId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ObligationSource[];
    },
    staleTime: 60_000,
  });
}

export function useThreadMessages(threadId: string | null) {
  return useQuery({
    queryKey: ["messages", threadId],
    enabled: !!threadId,
    queryFn: async (): Promise<Message[]> => {
      const { data, error } = await supabase
        .from("messages")
        .select("id,thread_id,direction,channel,from_name,from_identifier,to_identifiers,subject,snippet,body_text,sent_at")
        .eq("thread_id", threadId!)
        .order("sent_at");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useItemEvents(itemId: string | null) {
  return useQuery({
    queryKey: ["item-events", itemId],
    enabled: !!itemId,
    queryFn: async (): Promise<QueueEvent[]> => {
      const { data, error } = await supabase
        .from("queue_item_events")
        .select("*")
        .eq("queue_item_id", itemId!)
        .order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });
}

// Return a confirmed row: a successful HTTP response with no affected row is
// not a saved action. The DB trigger records state transitions as user actions.
export function useItemAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; patch: Partial<QueueItem>; expected?: Pick<QueueItem, "state" | "updated_at" | "snoozed_until" | "follow_up_at" | "last_inbound_message_id" | "message_count"> }) => {
      let query = supabase.from("queue_items").update(args.patch).eq("id", args.id);
      if (args.expected) {
        for (const [key, value] of Object.entries(args.expected)) {
          query = value === null ? query.is(key, null) : query.eq(key, value);
        }
      }
      const { data, error } = await query.select("*").single();
      if (error) throw error;
      if (!queueActionConfirmed(args.id, args.patch, data)) throw new Error("Save was not confirmed. Refresh before retrying.");
      return data as QueueItem;
    },
    onSettled: (_data, _error, { id }) => Promise.all([
      qc.invalidateQueries({ queryKey: ["queue"] }),
      qc.invalidateQueries({ queryKey: ["queue-page"] }),
      qc.invalidateQueries({ queryKey: ["item", id] }),
      qc.invalidateQueries({ queryKey: ["item-events", id] }),
    ]),
  });
}

export function useContact(contactId: string | null) {
  return useQuery({
    queryKey: ["contact", contactId],
    enabled: !!contactId,
    queryFn: async (): Promise<Contact | null> => {
      const { data, error } = await supabase.from("contacts").select("*").eq("id", contactId!).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useContactChannels(contactId: string | null) {
  return useQuery({
    queryKey: ["contact-channels", contactId],
    enabled: !!contactId,
    queryFn: async (): Promise<ContactChannel[]> => {
      const { data, error } = await supabase
        .from("contact_channels")
        .select("id,channel_type,raw_value,canonical_value")
        .eq("contact_id", contactId!)
        .order("channel_type")
        .order("canonical_value");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useStrategies(contactId: string | null) {
  return useQuery({
    queryKey: ["strategies", contactId],
    enabled: !!contactId,
    queryFn: async (): Promise<ContactStrategy[]> => {
      const { data, error } = await supabase
        .from("contact_strategies")
        .select("*")
        .eq("contact_id", contactId!)
        .neq("status", "superseded")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useArtifactOutput(artifactId: string | null) {
  return useQuery({
    queryKey: ["artifact", artifactId],
    enabled: !!artifactId,
    queryFn: async (): Promise<Record<string, unknown> | null> => {
      const { data, error } = await supabase
        .from("pipeline_artifacts")
        .select("output")
        .eq("id", artifactId!)
        .maybeSingle();
      if (error) throw error;
      return (data?.output as Record<string, unknown>) ?? null;
    },
  });
}

export function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 3600_000) return `${Math.max(1, Math.round(diff / 60000))}m ago`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`;
  if (diff < 7 * 86400_000) return `${Math.round(diff / 86400_000)}d ago`;
  return d.toLocaleDateString();
}


export function useMccIntegrityStatus() {
  return useQuery({
    queryKey: ["mcc-integrity-status"],
    queryFn: async (): Promise<MccIntegrityStatus | null> => {
      const { data, error } = await supabase
        .from("mcc_integrity_status")
        .select("*")
        .maybeSingle();
      if (error) throw error;
      return data as MccIntegrityStatus | null;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useProductionChangeReceipts() {
  return useQuery({
    queryKey: ["production-change-receipts"],
    queryFn: async (): Promise<ProductionChangeReceipt[]> => {
      const { data, error } = await supabase
        .from("production_change_receipts")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(25);
      if (error) throw error;
      return (data ?? []) as ProductionChangeReceipt[];
    },
    staleTime: 60_000,
  });
}


export function useObligationEvents(obligationId: string | null) {
  return useQuery({
    queryKey: ["obligation-events", obligationId],
    enabled: !!obligationId,
    queryFn: async (): Promise<ObligationEvent[]> => {
      const { data, error } = await supabase
        .from("obligation_events")
        .select("id,obligation_id,event_type,actor_type,actor_ref,old_value,new_value,reason,source_ref,created_at")
        .eq("obligation_id", obligationId!)
        .order("created_at", { ascending: false })
        .limit(25);
      if (error) throw error;
      return (data ?? []) as ObligationEvent[];
    },
    staleTime: 15_000,
  });
}

export function useMccObligationAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: MccManualActionInput) =>
      api<{ ok: boolean; obligation_id: string; state?: string; execution_owner?: string; event_type?: string }>(
        "mcc-obligation-action",
        args,
      ),
    onSuccess: async (_data, variables) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["mcc-today"] }),
        qc.invalidateQueries({ queryKey: ["mcc-captures"] }),
        qc.invalidateQueries({ queryKey: ["mcc-integrity-status"] }),
        qc.invalidateQueries({ queryKey: ["obligation-events", variables.obligation_id] }),
      ]);
    },
  });
}

export function useMccCaptures() {
  return useQuery({
    queryKey: ["mcc-captures"],
    queryFn: async () => {
      const { data, error } = await supabase.from("obligations")
        .select("id,title,description,created_at")
        .eq("state", "BLOCKED").eq("blocked_reason", "CAPTURED — NEEDS CLARIFICATION")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 60_000,
  });
}
export function useMccProjects() {
  return useQuery({
    queryKey: ["mcc-projects"],
    queryFn: async () => {
      const { data, error } = await supabase.from("projects").select("id,title").eq("state", "ACTIVE").order("title");
      if (error) throw error;
      return data ?? [];
    },
  });
}
export function useMccCapture() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { operation: "CAPTURE"; request_id: string; note: string } | { operation: "REVIEW"; obligation_id: string; next_action: string; project_id: string | null }) =>
      api<{ ok: boolean; obligation_id: string; idempotent?: boolean }>("mcc-fast-capture", body),
    onSuccess: async () => {
      await Promise.all(["mcc-captures", "mcc-today", "mcc-integrity-status", "obligation-events"].map(key => qc.invalidateQueries({ queryKey: [key] })));
    },
  });
}
