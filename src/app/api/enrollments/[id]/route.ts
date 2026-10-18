import { eq } from "drizzle-orm";
import { db, enrollments, sequences } from "@/db";
import { HttpError, assertMember, body, idOf, route } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/* After a reply: continue the sequence ("aktiv") or end it for this person ("beendet") */
export const PUT = route<Ctx>(async (req, { params }, me) => {
  const id = await idOf(params, "Kontakt"), b = await body(req);
  const [row] = await db.select({ e: enrollments, tenantId: sequences.tenantId }).from(enrollments).innerJoin(sequences, eq(sequences.id, enrollments.sequenceId)).where(eq(enrollments.id, id));
  if (!row) throw new HttpError(404, "Kontakt nicht gefunden");
  await assertMember(me, row.tenantId, "Kontakt");
  if (b.status !== "aktiv" && b.status !== "beendet") throw new HttpError(400, "Ungültiger Status");
  /* continuing: replies are checked again from now on, the one already seen does not pause again */
  await db.update(enrollments).set({ status: b.status, ...(b.status === "aktiv" ? { repliedAt: new Date() } : {}) }).where(eq(enrollments.id, id));
});
