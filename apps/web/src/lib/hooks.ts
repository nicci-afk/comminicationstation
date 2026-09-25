import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import type {
  Business,
  Contact,
  ContactChannel,
  ContactStrategy,
  MccTodayItem,
  Message,
  MccIntegrityStatus,
  ObligationEvent,
  ObligationSource,
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

export function useQueue(states: string[], businessId?: string | null) {
  return useQuery({
    queryKey: ["queue", states, businessId ?? "all"],
    queryFn: async (): Promise<QueueItem[]> => {
      let q = supabase
        .from("queue_items")
        .select("*")
        .in("state", states)
        .order("priority", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(200);
      if (businessId) q = q.eq("business_id", businessId);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
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
      })
      .subscribe();
    const interval = setInterval(() => qc.invalidateQueries({ queryKey: ["queue"] }), 60_000);
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
        .order("id", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as ObligationEvent[];
    },
    staleTime: 15_000,
  });
}

export type ObligationManualAction =
  | { type: "DONE" }
  | { type: "BLOCKED"; reason: string }
  | { type: "NEED_HELP" }
  | { type: "UNDO" };

const OBLIGATION_STATES = new Set([
  "NOW",
  "TODAY",
  "THIS_WEEK",
  "UPCOMING",
  "WAITING",
  "BLOCKED",
  "SOMEDAY",
  "DONE",
  "CANCELLED",
]);

const EXECUTION_OWNERS = new Set([
  "NICCI",
  "CHATGPT",
  "CHATGPT_PREP",
  "OTHER",
  "WAITING",
]);

export function useObligationAction() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (args: { id: string; action: ObligationManualAction }) => {
      const { data: authData, error: authError } = await supabase.auth.getUser();
      if (authError) throw authError;
      const userId = authData.user?.id;
      if (!userId) throw new Error("No authenticated user");

      let patch: Record<string, string | null>;

      if (args.action.type === "DONE") {
        patch = {
          state: "DONE",
          completed_at: new Date().toISOString(),
          blocked_reason: null,
        };
      } else if (args.action.type === "BLOCKED") {
        const reason = args.action.reason.trim();
        if (!reason) throw new Error("A blocker reason is required");
        patch = {
          state: "BLOCKED",
          completed_at: null,
          blocked_reason: reason,
        };
      } else if (args.action.type === "NEED_HELP") {
        patch = {
          execution_owner: "CHATGPT_PREP",
        };
      } else {
        const { data: latest, error: eventError } = await supabase
          .from("obligation_events")
          .select("old_value")
          .eq("user_id", userId)
          .eq("obligation_id", args.id)
          .eq("event_type", "MANUAL_UPDATE")
          .eq("actor_ref", "mcc-executive-ui")
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (eventError) throw eventError;
        const oldValue = latest?.old_value as Record<string, unknown> | null | undefined;
        if (!oldValue) throw new Error("No manual MCC change is available to undo");

        const state = typeof oldValue.state === "string" ? oldValue.state : null;
        const executionOwner =
          typeof oldValue.execution_owner === "string" ? oldValue.execution_owner : null;
        const blockedReason =
          typeof oldValue.blocked_reason === "string" ? oldValue.blocked_reason : null;
        const completedAt =
          typeof oldValue.completed_at === "string" ? oldValue.completed_at : null;

        if (!state || !OBLIGATION_STATES.has(state)) {
          throw new Error("Undo history contains an invalid prior state");
        }
        if (!executionOwner || !EXECUTION_OWNERS.has(executionOwner)) {
          throw new Error("Undo history contains an invalid prior owner");
        }

        patch = {
          state,
          execution_owner: executionOwner,
          blocked_reason: blockedReason,
          completed_at: completedAt,
        };
      }

      const { data, error } = await supabase
        .from("obligations")
        .update(patch)
        .eq("id", args.id)
        .eq("user_id", userId)
        .select("id")
        .single();

      if (error) throw error;
      return data;
    },
    onSettled: (_data, _error, variables) => {
      qc.invalidateQueries({ queryKey: ["mcc-today"] });
      qc.invalidateQueries({ queryKey: ["mcc-integrity-status"] });
      qc.invalidateQueries({ queryKey: ["obligation-events", variables.id] });
    },
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

// User actions are direct RLS-guarded updates — ~0 perceived latency, and the
// DB trigger records the audit event with actor='user'.
export function useItemAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; patch: Partial<QueueItem> }) => {
      const { error } = await supabase.from("queue_items").update(args.patch).eq("id", args.id);
      if (error) throw error;
    },
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ["queue"] });
      qc.setQueriesData({ queryKey: ["queue"] }, (old: QueueItem[] | undefined) =>
        old?.map((i) => (i.id === id ? { ...i, ...patch } : i)),
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["queue"] }),
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
