import { and, eq, inArray } from "drizzle-orm";
import { db, leads, messages } from "@/db";
import { HttpError, assertMember, route } from "@/lib/api";
import { idsOf } from "@/lib/outreach";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, { params }, me) => {
  const id = Number((await params).id), b = await req.json();
  const [m] = await db.select().from(messages).where(eq(messages.id, id));
  if (!m) throw new HttpError(404, "Nachricht nicht gefunden");
  await assertMember(me, m.tenantId, "Nachricht");
  const set: Partial<typeof messages.$inferInsert> = {};
  if ("subject" in b) set.subject = b.subject;
  if ("body" in b) set.body = b.body;
  if (b.variant) { set.variant = b.variant; set.subject = null; set.body = null; }
  if (b.channel) set.channel = b.channel;
  if (b.action === "reset") { set.subject = null; set.body = null; }
  if (b.action === "approve") {
    if (!b.finalBody) throw new HttpError(400, "Text fehlt");
    Object.assign(set, { status: "freigegeben", finalSubject: b.finalSubject || "", finalBody: b.finalBody, senderId: me.id, error: "" });
  }
  if (b.action === "skip") set.status = m.status === "uebersprungen" ? "entwurf" : "uebersprungen";
  await db.update(messages).set(set).where(and(eq(messages.id, id)));
  if (b.action === "skip") await db.update(leads).set({ status: set.status === "uebersprungen" ? "neu" : "freigabe" }).where(inArray(leads.id, idsOf(m)));
});
