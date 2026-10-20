import { eq } from "drizzle-orm";
import { db, tenants, type AiChoice } from "@/db";
import { getInteg } from "./integrations";
import { AI_PROVIDERS, CLAUDE_MODELS, OPENAI_MODELS, OPENROUTER_MODELS, REQUESTY_MODELS, type AiKind } from "./integ-meta";
import { spend } from "./usage";

export { CLAUDE_MODELS, OPENAI_MODELS, OPENROUTER_MODELS, REQUESTY_MODELS };

/* Which model answers for a tenant. A plain string is an Anthropic API key (older callers). */
export type Ai = string | { provider: "anthropic" | "openrouter" | "requesty" | "openai"; key: string; model?: string };

/* Endpoints and server-wide keys from the environment (see .env.example). A server key only answers for accounts without their own */
export const AI_ENV: Record<AiKind, { key?: string; base: string }> = {
  claude: { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com" },
  openrouter: { key: process.env.OPENROUTER_API_KEY, base: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1" },
  requesty: { key: process.env.REQUESTY_API_KEY, base: process.env.REQUESTY_BASE_URL || "https://router.requesty.ai/v1" },
  openai: { key: process.env.OPENAI_API_KEY, base: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1" },
};

/* Tenants that picked "claude" before there was a model list keep the model they had */
export const CLAUDE_LEGACY = "claude-sonnet-5-5";
const VIA: Record<AiKind, string> = { claude: "", openrouter: " über OpenRouter", requesty: " über Requesty", openai: " über OpenAI" };
const models = (k: AiKind) => AI_PROVIDERS.find(p => p.k === k)!.models;
export const modelName = (id: string) => AI_PROVIDERS.flatMap(p => p.models).find(([m]) => m === id)?.[1] || id;
const modelOf = (c: AiChoice) => c.kind === "claude" ? c.model || CLAUDE_LEGACY : c.model;
export const choiceId = (c: AiChoice) => `${c.kind}:${modelOf(c)}`;
export const choiceLabel = (c: AiChoice) => modelName(modelOf(c)) + VIA[c.kind];
export function choiceOf(id: string): AiChoice | null {
  if (id === "claude") return { kind: "claude", model: CLAUDE_LEGACY };
  const i = id.indexOf(":"), kind = id.slice(0, i) as AiKind, m = id.slice(i + 1);
  if (i < 0 || !AI_PROVIDERS.some(p => p.k === kind) || !models(kind).some(([x]) => x === m)) return null;
  return { kind, model: m } as AiChoice;
}
const PROVIDER: Record<AiKind, Exclude<Ai, string>["provider"]> = { claude: "anthropic", openrouter: "openrouter", requesty: "requesty", openai: "openai" };
/* How a running Ai reads in lists, e.g. the MCP tenant overview */
export const aiLabel = (ai: Ai) => {
  if (typeof ai === "string") return modelName(CLAUDE_LEGACY);
  const k = (Object.keys(PROVIDER) as AiKind[]).find(x => PROVIDER[x] === ai.provider)!;
  return modelName(ai.model || models(k)[0][0]) + VIA[k];
};

/* The account's own key, else the server key from the environment */
async function keys(tenantId: number, userId?: number) {
  const rows = await Promise.all(AI_PROVIDERS.map(p => getInteg(tenantId, p.k, userId)));
  return AI_PROVIDERS.map((p, i) => ({ k: p.k, key: rows[i]?.key || AI_ENV[p.k].key || "", model: rows[i]?.model }));
}

/* What the connected keys allow: every model of each provider with a key */
export async function aiOptions(tenantId: number, userId?: number): Promise<AiChoice[]> {
  return (await keys(tenantId, userId)).filter(x => x.key).flatMap(x => models(x.k).map(([model]) => ({ kind: x.k, model }) as AiChoice));
}

/* The tenant's own choice when its key is still connected; otherwise the first provider with a key in AI_PROVIDERS order
   (Anthropic first for server-side fallback and pause_turn). Keys belong to the account, userId picks whose. */
export async function aiFor(tenantId: number, userId?: number): Promise<Ai | null> {
  const [[t], ks] = await Promise.all([db.select({ s: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)), keys(tenantId, userId)]);
  const pick = t?.s.ai, as = (x: (typeof ks)[number]) => ({ provider: PROVIDER[x.k], key: x.key,
    model: pick?.kind === x.k ? modelOf(pick) : x.k === "claude" ? CLAUDE_LEGACY : x.model || models(x.k)[0][0] });
  const chosen = ks.find(x => x.k === pick?.kind && x.key), first = ks.find(x => x.key);
  return chosen ? as(chosen) : first ? as(first) : null;
}

export class AiMissing extends Error { constructor() { super("Keine KI verbunden. Unter Einstellungen → Integrationen → KI einen Anbieter verbinden."); } }

type Msg = { role: "user" | "assistant"; content: string };

/* Reads a server-sent event stream and hands each JSON payload to onEvent */
async function sse(r: Response, onEvent: (j: Record<string, unknown>) => void) {
  const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split("\n"); buf = lines.pop() ?? "";
    for (const l of lines) if (l.startsWith("data:") && !l.includes("[DONE]")) onEvent(JSON.parse(l.slice(5)));
  }
}

type Chat = { provider: "openrouter" | "requesty"; key: string; model?: string };

/* Chat completion over OpenRouter or Requesty, both OpenAI-compatible. Web search: OpenRouter through the web plugin,
   Requesty through its web_search tool (native for Anthropic, OpenAI, Google, xAI). onText gets the text so far while it streams */
export async function chatAsk(ai: Chat, system: string, messages: Msg[], web: boolean, maxResults: number, signal?: AbortSignal, onText?: (text: string) => void): Promise<string> {
  const or = ai.provider === "openrouter", name = or ? "OpenRouter" : "Requesty";
  const r = await fetch(`${AI_ENV[ai.provider].base}/chat/completions`, {
    method: "POST", signal,
    headers: { authorization: `Bearer ${ai.key}`, "content-type": "application/json", "x-title": "Sales Portal", "http-referer": "https://sales-portal-sooty.vercel.app" },
    body: JSON.stringify({
      model: ai.model || (or ? OPENROUTER_MODELS : REQUESTY_MODELS)[0][0], max_tokens: 16000, stream: !!onText,
      messages: [{ role: "system", content: system }, ...messages],
      ...or ? { usage: { include: true }, plugins: web ? [{ id: "web", max_results: Math.min(10, Math.max(3, maxResults)) }] : undefined }
        : { tools: web ? [{ type: "web_search" }] : undefined },
    }),
  });
  if (onText && r.ok && r.body) {
    let text = "", cost: number | null = null;
    await sse(r, j => {
      const e = j as { error?: { message?: string }; choices?: { delta?: { content?: string } }[]; usage?: { cost?: number } };
      if (e.error) throw new Error(`${name}: ${e.error.message}`);
      if (e.usage?.cost != null) cost = e.usage.cost;
      const d = e.choices?.[0]?.delta?.content;
      if (d) { text += d; onText(text); }
    });
    spend(cost);
    return text;
  }
  const j = await r.json().catch(() => ({})) as { error?: { message?: string }; choices?: { message?: { content?: string } }[]; usage?: { cost?: number } };
  if (!r.ok) throw new Error(`${name}: ${j.error?.message || r.status}`);
  spend(j.usage?.cost);
  return j.choices?.[0]?.message?.content || "";
}

export const openrouterAsk = (ai: { key: string; model?: string }, system: string, messages: Msg[], web: boolean, maxResults: number, signal?: AbortSignal, onText?: (text: string) => void) =>
  chatAsk({ ...ai, provider: "openrouter" }, system, messages, web, maxResults, signal, onText);

/* OpenAI directly through the Responses API, which has web search as a built-in tool */
export async function openaiAsk(ai: { key: string; model?: string }, system: string, messages: Msg[], web: boolean, signal?: AbortSignal, onText?: (text: string) => void): Promise<string> {
  const r = await fetch(`${AI_ENV.openai.base}/responses`, {
    method: "POST", signal,
    headers: { authorization: `Bearer ${ai.key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: ai.model || OPENAI_MODELS[0][0], instructions: system, input: messages, max_output_tokens: 16000, stream: !!onText,
      tools: web ? [{ type: "web_search", user_location: { type: "approximate", country: "DE", timezone: "Europe/Berlin" } }] : undefined }),
  });
  if (onText && r.ok && r.body) {
    let text = "";
    await sse(r, j => {
      const e = j as { type?: string; delta?: string; error?: { message?: string }; response?: { error?: { message?: string } } };
      if (e.type === "error" || e.type === "response.failed") throw new Error(`OpenAI: ${e.error?.message || e.response?.error?.message || "Fehler"}`);
      if (e.type === "response.output_text.delta" && e.delta) { text += e.delta; onText(text); }
    });
    spend(null);
    return text;
  }
  const j = await r.json().catch(() => ({})) as { error?: { message?: string }; output?: { type: string; content?: { type: string; text?: string }[] }[] };
  if (!r.ok) throw new Error(`OpenAI: ${j.error?.message || r.status}`);
  spend(null);
  return (j.output || []).filter(o => o.type === "message").flatMap(o => o.content || []).filter(c => c.type === "output_text").map(c => c.text).join("\n");
}

/* Interactive chats with tools take a fast, cheap model, whatever the tenant picked for research: GPT-5.6 Luna over the account's
   OpenRouter key (reports the cost), else OpenAI directly, else Requesty */
export const CHAT_MODEL = "gpt-5.6-luna";
export type ChatKey = { provider: "openrouter" | "openai" | "requesty"; key: string; model: string };
export async function chatKey(tenantId: number, userId?: number): Promise<ChatKey | null> {
  const ks = await keys(tenantId, userId), key = (k: AiKind) => ks.find(x => x.k === k && x.key)?.key;
  const or = key("openrouter"), oa = key("openai"), rq = key("requesty");
  return or ? { provider: "openrouter", key: or, model: `openai/${CHAT_MODEL}` } : oa ? { provider: "openai", key: oa, model: CHAT_MODEL }
    : rq ? { provider: "requesty", key: rq, model: `openai/${CHAT_MODEL}` } : null;
}

export type Tool = { name: string; description: string; parameters: object; run: (args: Record<string, unknown>) => Promise<unknown> };
export type ToolMsg = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]; tool_call_id?: string };

/* Chat completions with tools (OpenAI, OpenRouter and Requesty speak the same format): streams the text, runs the tools the model calls,
   one after the other, and goes on until it answers without a tool. onText gets the answer so far; a failing tool reports its error to the model */
export async function toolChat(ai: ChatKey, messages: ToolMsg[], tools: Tool[], signal?: AbortSignal, onText?: (text: string) => void): Promise<string> {
  const name = { openrouter: "OpenRouter", openai: "OpenAI", requesty: "Requesty" }[ai.provider], said: string[] = [];
  for (let turn = 0; turn < 10; turn++) {
    const r = await fetch(`${AI_ENV[ai.provider].base}/chat/completions`, {
      method: "POST", signal,
      headers: { authorization: `Bearer ${ai.key}`, "content-type": "application/json", "x-title": "Sales Portal", "http-referer": "https://sales-portal-sooty.vercel.app" },
      body: JSON.stringify({
        model: ai.model, stream: true, messages, parallel_tool_calls: true,
        tools: tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
        ...ai.provider === "openrouter" ? { max_tokens: 6000, reasoning: { effort: "low" }, usage: { include: true } }
          : { max_completion_tokens: 6000, reasoning_effort: "low", ...ai.provider === "openai" ? { stream_options: { include_usage: true } } : {} },
      }),
    });
    if (!r.ok || !r.body) { const j = await r.json().catch(() => ({})) as { error?: { message?: string } }; throw new Error(`${name}: ${j.error?.message || r.status}`); }
    let text = "", cost: number | null = null;
    const calls: { id: string; name: string; args: string }[] = [];
    await sse(r, j => {
      const e = j as { error?: { message?: string }; usage?: { cost?: number }; choices?: { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] };
      if (e.error) throw new Error(`${name}: ${e.error.message}`);
      if (e.usage?.cost != null) cost = e.usage.cost;
      const d = e.choices?.[0]?.delta;
      if (d?.content) { text += d.content; onText?.([...said, text].join("\n\n")); }
      for (const tc of d?.tool_calls ?? []) {
        const c = calls[tc.index] ??= { id: "", name: "", args: "" };
        if (tc.id) c.id = tc.id;
        c.name += tc.function?.name ?? ""; c.args += tc.function?.arguments ?? "";
      }
    });
    spend(cost);
    if (text.trim()) said.push(text.trim());
    const todo = calls.filter(Boolean);
    if (!todo.length) return said.join("\n\n");
    messages.push({ role: "assistant", content: text || null, tool_calls: todo.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })) });
    for (const c of todo) {
      let out: unknown;
      try {
        const tool = tools.find(t => t.name === c.name);
        if (!tool) throw new Error(`Unbekanntes Werkzeug ${c.name}`);
        out = await tool.run(JSON.parse(c.args || "{}"));
      } catch (e) { if (signal?.aborted) throw e; out = { fehler: (e as Error).message }; }
      messages.push({ role: "tool", tool_call_id: c.id, content: typeof out === "string" ? out : JSON.stringify(out) });
    }
  }
  throw new Error("Die KI hat die Aufgabe nicht abgeschlossen, bitte noch einmal kürzer fragen");
}

export async function openrouterVerify(key: string) {
  const r = await fetch(`${AI_ENV.openrouter.base}/key`, { headers: { authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error("Schlüssel ungültig");
  const j = await r.json() as { data?: { label?: string; limit_remaining?: number | null } };
  return j.data?.limit_remaining != null ? `${j.data.limit_remaining.toFixed(2)} $ Guthaben` : "";
}

/* Requesty and OpenAI: a key that may list the models is valid */
export async function modelsVerify(kind: "requesty" | "openai", key: string) {
  const r = await fetch(`${AI_ENV[kind].base}/models`, { headers: { authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error("Schlüssel ungültig");
}
