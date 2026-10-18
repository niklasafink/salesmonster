import { eq } from "drizzle-orm";
import { db, tenants } from "@/db";
import { HttpError, qp, route, tenantBySlug } from "@/lib/api";
import { aiFor, aiOptions, choiceId, choiceLabel, choiceOf } from "@/lib/ai";
import { act, applySetup, listChats, loadSetup, newSetup, promptParts, switchSetup, PROMPT_KEY, type Action, type Setup } from "@/lib/setup";

export const maxDuration = 300;

type Tenant = Awaited<ReturnType<typeof tenantBySlug>>;

/* Before the first step the user picks the model for this tenant; later changes go through Einstellungen */
async function chooser(t: Tenant, su: Setup, userId: number) {
  if (t.settings.ai && su.chat.length) return null;
  const options = (await aiOptions(t.id, userId)).map(c => ({ id: choiceId(c), label: choiceLabel(c) }));
  if (!options.length) return null;
  const best = options.find(o => o.id === "claude:claude-opus-5-5");
  return { options, question: `Welche KI soll ${t.name} nutzen?${best ? ` Für die Einrichtung empfehle ich ${best.label}, sie recherchiert am gründlichsten.` : ""}` };
}

/* The full state of one chat, as after loading the page */
async function full(t: Tenant, su: Setup, userId: number) {
  const c = await chooser(t, su, userId);
  return { setup: su, parts: promptParts(t, su), keys: PROMPT_KEY, ai: !!(await aiFor(t.id, userId)), choose: c?.options ?? null, question: c?.question ?? "", chats: await listChats(t.id) };
}

export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  return full(t, await loadSetup(t.id), me.id);
});

export const POST = route(async (req, _c, me) => {
  const b = await req.json() as Action & { t: string } | { t: string; action: "apply"; prompt?: string; templates?: boolean; leads?: boolean } | { t: string; action: "model"; id: string }
    | { t: string; action: "new" } | { t: string; action: "switch"; id: number };
  let t = await tenantBySlug(b.t, me);
  const su = await loadSetup(t.id);
  if (b.action === "new") return full(t, await newSetup(t.id, su), me.id);
  if (b.action === "switch") {
    const next = await switchSetup(t.id, Number(b.id));
    if (!next) throw new HttpError(404, "Chat nicht gefunden");
    return full(t, next, me.id);
  }
  if (b.action === "apply") return { applied: await applySetup(t, su, b) };
  if (b.action === "model") {
    const c = await chooser(t, su, me.id), o = c?.options.find(x => x.id === b.id), pick = o && choiceOf(o.id);
    if (!c || !o || !pick) throw new HttpError(400, "KI unbekannt");
    await db.update(tenants).set({ settings: { ...t.settings, ai: pick } }).where(eq(tenants.id, t.id));
    t = { ...t, settings: { ...t.settings, ai: pick } };
    /* the question and the answer stay in the chat, then step 1 starts with the chosen model */
    const next = await act(t, await aiFor(t.id, me.id), su, { action: "start", intro: [{ role: "ai", text: c.question, step: su.step }, { role: "me", text: o.label, step: su.step }] });
    return { setup: next, parts: promptParts(t, next), keys: PROMPT_KEY, ai: true, choose: null, question: "", chats: await listChats(t.id) };
  }
  if (!["start", "message", "auto", "next", "skip", "goto", "votes", "prompt"].includes(b.action)) throw new HttpError(400, "Unbekannte Aktion");
  const { intro: _drop, ...a } = b as Action & { t: string };
  const next = await act(t, await aiFor(t.id, me.id), su, a);
  return { setup: next, parts: promptParts(t, next), keys: PROMPT_KEY, chats: await listChats(t.id) };
});
