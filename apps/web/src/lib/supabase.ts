import { createClient } from "@supabase/supabase-js";
import { API_BASE, SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Call a backend route (functions/v1/api/<route>) with the user's JWT.
export async function api<T = unknown>(
  route: string,
  body?: unknown,
  method: "POST" | "GET" = body === undefined ? "GET" : "POST",
): Promise<T> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  const res = await fetch(`${API_BASE}/${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((json as { error?: string }).error ?? `${route} failed (${res.status})`);
  }
  return json as T;
}
