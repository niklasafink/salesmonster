import { eq } from "drizzle-orm";
import { db, tenants, type AiChoice } from "@/db";
import { getInteg } from "./integrations";
import { OPENROUTER_MODELS } from "./integ-meta";

export { OPENROUTER_MODELS };

/* Which model answers for a tenant. A plain string is an Anthropic API key (older callers). */
export type Ai = string | { provider: "anthropic" | "openrouter"; key: string; model?: string };

export const modelName = (id: string) => OPENROUTER_MODELS.find(([m]) => m === id)?.[1] || id;
export const choiceId = (c: AiChoice) => c.kind === "claude" ? "claude" : `openrouter:${c.model}`;
export const choiceLabel = (c: AiChoice) => c.kind === "claude" ? "Claude Sonnet 5.5" : `${modelName(c.model)} über OpenRouter`;
export function choiceOf(id: string): AiChoice | null {
  if (id === "claude") return { kind: "claude" };
  const m = id.startsWith("openrouter:") ? id.slice(11) : "";
  return OPENROUTER_MODELS.some(([x]) => x === m) ? { kind: "openrouter", model: m } : null;
}

/* What the account's connected keys allow: Claude, and every OpenRouter model once an OpenRouter key exists */
export async function aiOptions(tenantId: number, userId?: number): Promise<AiChoice[]> {
  const [c, o] = await Promise.all([getInteg(tenantId, "claude", userId), getInteg(tenantId, "openrouter", userId)]);
  return [...(c?.key ? [{ kind: "claude" as const }] : []), ...(o?.key ? OPENROUTER_MODELS.map(([model]) => ({ kind: "openrouter" as const, model })) : [])];
}

/* The tenant's own choice when its key is still connected; otherwise Anthropic first (server-side fallback and pause_turn), then OpenRouter.
   Keys belong to the account, userId picks whose. */
export async function aiFor(tenantId: number, userId?: number): Promise<Ai | null> {
  const [[t], c, o] = await Promise.all([db.select({ s: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)),
    getInteg(tenantId, "claude", userId), getInteg(tenantId, "openrouter", userId)]);
  const pick = t?.s.ai;
  const claude = c?.key ? { provider: "anthropic" as const, key: c.key } : null;
  const or = o?.key ? { provider: "openrouter" as const, key: o.key, model: pick?.kind === "openrouter" ? pick.model : o.model || OPENROUTER_MODELS[0][0] } : null;
  return pick?.kind === "openrouter" ? or ?? claude : claude ?? or;
}

export class AiMissing extends Error { constructor() { super("Keine KI verbunden. Unter Einstellungen → Integrationen OpenRouter oder Claude verbinden."); } }

type Msg = { role: "user" | "assistant"; content: string };

/* OpenRouter chat completion; web search through the web plugin (native search for Anthropic, OpenAI, Google models) */
export async function openrouterAsk(ai: { key: string; model?: string }, system: string, messages: Msg[], web: boolean, maxResults: number): Promise<string> {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${ai.key}`, "content-type": "application/json", "x-title": "Sales Portal", "http-referer": "https://sales-portal-sooty.vercel.app" },
    body: JSON.stringify({
      model: ai.model || OPENROUTER_MODELS[0][0], max_tokens: 16000,
      messages: [{ role: "system", content: system }, ...messages],
      plugins: web ? [{ id: "web", max_results: Math.min(10, Math.max(3, maxResults)) }] : undefined,
    }),
  });
  const j = await r.json().catch(() => ({})) as { error?: { message?: string }; choices?: { message?: { content?: string } }[] };
  if (!r.ok) throw new Error(`OpenRouter: ${j.error?.message || r.status}`);
  return j.choices?.[0]?.message?.content || "";
}

export async function openrouterVerify(key: string) {
  const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error("Schlüssel ungültig");
  const j = await r.json() as { data?: { label?: string; limit_remaining?: number | null } };
  return j.data?.limit_remaining != null ? `${j.data.limit_remaining.toFixed(2)} $ Guthaben` : "";
}
