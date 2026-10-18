import { eq } from "drizzle-orm";
import { db, messages } from "@/db";
import { HttpError, assertMember, body, idOf, route } from "@/lib/api";
import { calibration, draftText, judge } from "@/lib/drafts";
import { jevKey } from "@/lib/jev";

type Ctx = { params: Promise<{ id: string }> };

/* Score of the draft as shown, or of the text the review screen sends while it is being edited */
export const POST = route<Ctx>(async (req, { params }, me) => {
  const id = await idOf(params, "Nachricht"), b = await body(req);
  const [m] = await db.select().from(messages).where(eq(messages.id, id));
  if (!m) throw new HttpError(404, "Nachricht nicht gefunden");
  await assertMember(me, m.tenantId, "Nachricht");
  const key = await jevKey(m.tenantId, me.id);
  if (!key) throw new HttpError(400, "OpenRouter ist nicht verbunden (für Jev)");
  const shown = await draftText(m);
  const text = typeof b.subject === "string" && typeof b.body === "string" ? { subject: b.subject, body: b.body } : shown;
  const score = await judge(key, text, shown.lead, m.score, await calibration(m.tenantId));
  await db.update(messages).set({ score }).where(eq(messages.id, id));
  return { total: score.total, issues: score.issues, ...(score.expected !== undefined ? { expected: score.expected } : {}) };
});
