// Vendor callers for the three pipeline stages + cheap triage/draft calls.
// Every call returns parsed JSON plus token usage; cost is computed from the
// pricing table (approximate, config-overridable) and recorded by callers.

import Anthropic from "@anthropic-ai/sdk";

export interface LlmResult {
  parsed: unknown;
  raw: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model: string;
  provider: string;
}

// USD per million tokens {in, out}. Approximate; used for the spend ledger.
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "gpt-5.1": { in: 1.25, out: 10 },
  "gpt-5": { in: 1.25, out: 10 },
  "gpt-4.1": { in: 2, out: 8 },
  "sonar-pro": { in: 3, out: 15 },
  "sonar": { in: 1, out: 1 },
};

export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICING[model] ?? { in: 5, out: 25 };
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}

export function extractJson(text: string): unknown {
  // Models occasionally wrap JSON in fences or prose; extract the outermost object.
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (_e) {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      return JSON.parse(fenced[1].trim());
    }
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(trimmed.slice(first, last + 1));
    }
    throw new Error("no JSON object found in model output");
  }
}

export async function callAnthropic(args: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  thinking?: boolean;
}): Promise<LlmResult> {
  const client = new Anthropic({ apiKey: args.apiKey });
  const isAdaptiveOnly = /opus-4-[78]|sonnet-5|fable/.test(args.model);
  const response = await client.messages.create({
    model: args.model,
    max_tokens: args.maxTokens ?? 8192,
    system: args.system,
    // budget_tokens is removed on 4.7+ models; adaptive is the only on-mode.
    ...(args.thinking && isAdaptiveOnly ? { thinking: { type: "adaptive" as const } } : {}),
    messages: [{ role: "user", content: args.user }],
  });
  const raw = response.content
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text?: string }) => b.text ?? "")
    .join("");
  const tokensIn = response.usage.input_tokens;
  const tokensOut = response.usage.output_tokens;
  return {
    parsed: extractJson(raw),
    raw,
    tokensIn,
    tokensOut,
    costUsd: estimateCost(args.model, tokensIn, tokensOut),
    model: args.model,
    provider: "anthropic",
  };
}

export async function callOpenAI(args: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<LlmResult> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify({
      model: args.model,
      max_completion_tokens: args.maxTokens ?? 8192,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const body = await res.json();
  const raw: string = body.choices?.[0]?.message?.content ?? "";
  const tokensIn: number = body.usage?.prompt_tokens ?? 0;
  const tokensOut: number = body.usage?.completion_tokens ?? 0;
  return {
    parsed: extractJson(raw),
    raw,
    tokensIn,
    tokensOut,
    costUsd: estimateCost(args.model, tokensIn, tokensOut),
    model: args.model,
    provider: "openai",
  };
}

export async function callPerplexity(args: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<LlmResult> {
  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify({
      model: args.model,
      max_tokens: args.maxTokens ?? 8192,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Perplexity ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const body = await res.json();
  const raw: string = body.choices?.[0]?.message?.content ?? "";
  const tokensIn: number = body.usage?.prompt_tokens ?? 0;
  const tokensOut: number = body.usage?.completion_tokens ?? 0;
  return {
    parsed: extractJson(raw),
    raw,
    tokensIn,
    tokensOut,
    costUsd: estimateCost(args.model, tokensIn, tokensOut),
    model: args.model,
    provider: "perplexity",
  };
}
