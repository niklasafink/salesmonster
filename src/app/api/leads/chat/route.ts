import { chatKey } from "@/lib/ai";
import { HttpError, body, route, streamed, tenantBySlug } from "@/lib/api";
import { leadChat, type ChatMsg } from "@/lib/lead-chat";
import { track } from "@/lib/usage";

export const maxDuration = 120;

/* { t, messages }: the chat under the lead list; streams the answer as NDJSON and changes the list in the same turn */
export const POST = route(async (req, _c, me) => {
  const b = await body(req);
  const t = await tenantBySlug(String(b.t ?? ""), me);
  const msgs = Array.isArray(b.messages) ? (b.messages as ChatMsg[]).filter(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string").map(m => ({ role: m.role, content: m.content.slice(0, 4000) })) : [];
  if (msgs.at(-1)?.role !== "user") throw new HttpError(400, "Nachricht fehlt");
  const ai = await chatKey(t.id, me.id);
  if (!ai) throw new HttpError(400, "Der Chat braucht einen OpenRouter- oder OpenAI-Schlüssel. Unter Einstellungen → Integrationen → KI verbinden.");
  return streamed(onReply => track({ tenantId: t.id, userId: me.id, kind: "chat" }, async m => { m.count(1); return leadChat(ai, t, msgs, req.signal, onReply); }));
});
