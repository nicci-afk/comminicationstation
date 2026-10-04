// Deliberately isolated from legacy callers: one SDK attempt, no implicit retry.
import Anthropic from "@anthropic-ai/sdk";
import { extractJson } from "./_shared/llm.ts";

export interface TriageUsage {
  tokensIn: number;
  tokensOut: number;
  model: string;
  decision: Record<string, unknown> | null;
}

function supportedUsage(usage: Record<string, unknown>): boolean {
  const zeroTree = (value: unknown): boolean => value == null || value === 0 ||
    (typeof value === "object" && !Array.isArray(value) && Object.values(value).every(zeroTree));
  return Object.entries(usage).every(([key, value]) => {
    if (key === "input_tokens" || key === "output_tokens") return true;
    if (key === "service_tier") return value == null || value === "standard";
    if (["cache_creation_input_tokens", "cache_read_input_tokens", "cache_creation", "server_tool_use"].includes(key)) {
      return zeroTree(value);
    }
    return false; // Future billing dimensions require review, never a zero default.
  });
}

export async function callTriageOnce(args: {
  apiKey: string; model: string; system: string; user: string;
}): Promise<TriageUsage> {
  const client = new Anthropic({ apiKey: args.apiKey, maxRetries: 0, timeout: 45_000 });
  const response = await client.messages.create({
    model: args.model,
    max_tokens: 400,
    service_tier: "standard_only",
    system: args.system,
    messages: [{ role: "user", content: args.user }],
  });
  // Cache/tool/thinking/batch features are not enabled or priced by this path.
  // Unexpected usage cannot safely be valued under the reviewed policy.
  const usage = response.usage;
  if (!Number.isSafeInteger(usage?.input_tokens) || usage.input_tokens < 0 ||
      !Number.isSafeInteger(usage?.output_tokens) || usage.output_tokens < 0 ||
      !supportedUsage(usage as unknown as Record<string, unknown>)) {
    throw new Error("triage cost: unsupported or missing provider usage; reservation retained");
  }
  let decision: Record<string, unknown> | null = null;
  try {
    const parsed = extractJson(response.content
      .filter((part) => part.type === "text")
      .map((part) => part.type === "text" ? part.text : "").join(""));
    if (response.stop_reason === "end_turn" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      decision = parsed as Record<string, unknown>;
    }
  } catch { /* Still settle observed usage; malformed output is never a free retry. */ }
  return { tokensIn: usage.input_tokens, tokensOut: usage.output_tokens,
    model: response.model, decision };
}
