import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import type { Business, Contact, ContactStrategy, Message, Profile, QueueEvent, QueueItem } from "./types";

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
