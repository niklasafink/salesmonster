import { eq } from "drizzle-orm";
import { db, tenants, type AiChoice } from "@/db";
import { getInteg } from "./integrations";
import { CLAUDE_MODELS, OPENROUTER_MODELS } from "./integ-meta";
import { spend } from "./usage";

export { CLAUDE_MODELS, OPENROUTER_MODELS };

/* Which model answers for a tenant. A plain string is an Anthropic API key (older callers). */
export type Ai = string | { provider: "anthropic" | "openrouter"; key: string; model?: string };

/* Tenants that picked "claude" before there was a model list keep the model they had */
export const CLAUDE_LEGACY = "claude-sonnet-5-5";
export const modelName = (id: string) => [...CLAUDE_MODELS, ...OPENROUTER_MODELS].find(([m]) => m === id)?.[1] || id;
export const choiceId = (c: AiChoice) => c.kind === "claude" ? `claude:${c.model || CLAUDE_LEGACY}` : `openrouter:${c.model}`;
export const choiceLabel = (c: AiChoice) => c.kind === "claude" ? modelName(c.model || CLAUDE_LEGACY) : `${modelName(c.model)} über OpenRouter`;
export function choiceOf(id: string): AiChoice | null {
  if (id === "claude") return { kind: "claude", model: CLAUDE_LEGACY };
  if (id.startsWith("claude:")) { const m = id.slice(7); return CLAUDE_MODELS.some(([x]) => x === m) ? { kind: "claude", model: m } : null; }
  const m = id.startsWith("openrouter:") ? id.slice(11) : "";
  return OPENROUTER_MODELS.some(([x]) => x === m) ? { kind: "openrouter", model: m } : null;
}

/* What the account's connected keys allow: Claude, and every OpenRouter model once an OpenRouter key exists */
export async function aiOptions(tenantId: number, userId?: number): Promise<AiChoice[]> {
  const [c, o] = await Promise.all([getInteg(tenantId, "claude", userId), getInteg(tenantId, "openrouter", userId)]);
  return [...(c?.key ? CLAUDE_MODELS.map(([model]) => ({ kind: "claude" as const, model })) : []), ...(o?.key ? OPENROUTER_MODELS.map(([model]) => ({ kind: "openrouter" as const, model })) : [])];
}

/* The tenant's own choice when its key is still connected; otherwise Anthropic first (server-side fallback and pause_turn), then OpenRouter.
   Keys belong to the account, userId picks whose. */
export async function aiFor(tenantId: number, userId?: number): Promise<Ai | null> {
  const [[t], c, o] = await Promise.all([db.select({ s: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)),
    getInteg(tenantId, "claude", userId), getInteg(tenantId, "openrouter", userId)]);
  const pick = t?.s.ai;
  const claude = c?.key ? { provider: "anthropic" as const, key: c.key, model: pick?.kind === "claude" ? pick.model || CLAUDE_LEGACY : CLAUDE_LEGACY } : null;
  const or = o?.key ? { provider: "openrouter" as const, key: o.key, model: pick?.kind === "openrouter" ? pick.model : o.model || OPENROUTER_MODELS[0][0] } : null;
  return pick?.kind === "openrouter" ? or ?? claude : claude ?? or;
}

export class AiMissing extends Error { constructor() { super("Keine KI verbunden. Unter Einstellungen → Integrationen OpenRouter oder Claude verbinden."); } }

type Msg = { role: "user" | "assistant"; content: string };

/* OpenRouter chat completion; web search through the web plugin (native search for Anthropic, OpenAI, Google models).
   onText gets the text so far while it streams */
export async function openrouterAsk(ai: { key: string; model?: string }, system: string, messages: Msg[], web: boolean, maxResults: number, signal?: AbortSignal, onText?: (text: string) => void): Promise<string> {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST", signal,
    headers: { authorization: `Bearer ${ai.key}`, "content-type": "application/json", "x-title": "Sales Portal", "http-referer": "https://sales-portal-sooty.vercel.app" },
    body: JSON.stringify({
      model: ai.model || OPENROUTER_MODELS[0][0], max_tokens: 16000, stream: !!onText, usage: { include: true },
      messages: [{ role: "system", content: system }, ...messages],
      plugins: web ? [{ id: "web", max_results: Math.min(10, Math.max(3, maxResults)) }] : undefined,
    }),
  });
  if (onText && r.ok && r.body) {
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "", text = "", cost: number | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.startsWith("data:") || l.includes("[DONE]")) continue;
        const j = JSON.parse(l.slice(5)) as { error?: { message?: string }; choices?: { delta?: { content?: string } }[]; usage?: { cost?: number } };
        if (j.error) throw new Error(`OpenRouter: ${j.error.message}`);
        if (j.usage?.cost != null) cost = j.usage.cost;
        const d = j.choices?.[0]?.delta?.content;
        if (d) { text += d; onText(text); }
      }
    }
    spend(cost);
    return text;
  }
  const j = await r.json().catch(() => ({})) as { error?: { message?: string }; choices?: { message?: { content?: string } }[]; usage?: { cost?: number } };
  if (!r.ok) throw new Error(`OpenRouter: ${j.error?.message || r.status}`);
  spend(j.usage?.cost);
  return j.choices?.[0]?.message?.content || "";
}

export async function openrouterVerify(key: string) {
  const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error("Schlüssel ungültig");
  const j = await r.json() as { data?: { label?: string; limit_remaining?: number | null } };
  return j.data?.limit_remaining != null ? `${j.data.limit_remaining.toFixed(2)} $ Guthaben` : "";
}
