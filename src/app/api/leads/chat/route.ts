import { AiMissing, aiFor } from "@/lib/ai";
import { HttpError, body, route, tenantBySlug } from "@/lib/api";
import { leadChat, type ChatMsg } from "@/lib/lead-chat";
import { track } from "@/lib/usage";

export const maxDuration = 120;

/* { t, messages }: the chat under the lead list; answers and changes the list in one step */
export const POST = route(async (req, _c, me) => {
  const b = await body(req);
  const t = await tenantBySlug(String(b.t ?? ""), me);
  const msgs = Array.isArray(b.messages) ? (b.messages as ChatMsg[]).filter(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string").map(m => ({ role: m.role, content: m.content.slice(0, 4000) })) : [];
  if (msgs.at(-1)?.role !== "user") throw new HttpError(400, "Nachricht fehlt");
  const ai = await aiFor(t.id, me.id);
  if (!ai) throw new AiMissing();
  return track({ tenantId: t.id, userId: me.id, kind: "chat" }, async m => { m.count(1); return leadChat(ai, t, msgs); });
});
