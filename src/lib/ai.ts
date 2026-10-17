import { getInteg } from "./integrations";
import { OPENROUTER_MODELS } from "./integ-meta";

export { OPENROUTER_MODELS };

/* Which model answers for a tenant. A plain string is an Anthropic API key (older callers). */
export type Ai = string | { provider: "anthropic" | "openrouter"; key: string; model?: string };

/* Anthropic key wins when both are connected; it supports server-side fallback and pause_turn */
export async function aiFor(tenantId: number): Promise<Ai | null> {
  const c = await getInteg(tenantId, "claude");
  if (c?.key) return { provider: "anthropic", key: c.key };
  const o = await getInteg(tenantId, "openrouter");
  if (o?.key) return { provider: "openrouter", key: o.key, model: o.model || OPENROUTER_MODELS[0][0] };
  return null;
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
