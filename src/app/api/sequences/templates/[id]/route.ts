import { and, eq, ne } from "drizzle-orm";
import { db, sequenceTemplates, sequences } from "@/db";
import { HttpError, assertMember, body, idOf, route } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

async function load(params: Ctx["params"], me: { id: number }) {
  const id = await idOf(params, "Variante");
  const [row] = await db.select({ x: sequenceTemplates, tenantId: sequences.tenantId }).from(sequenceTemplates).innerJoin(sequences, eq(sequences.id, sequenceTemplates.sequenceId)).where(eq(sequenceTemplates.id, id));
  if (!row) throw new HttpError(404, "Variante nicht gefunden");
  await assertMember(me, row.tenantId, "Variante");
  return row.x;
}

/* other active variants of the same step */
const others = (x: typeof sequenceTemplates.$inferSelect) => db.select({ id: sequenceTemplates.id }).from(sequenceTemplates)
  .where(and(eq(sequenceTemplates.sequenceId, x.sequenceId), eq(sequenceTemplates.step, x.step), ne(sequenceTemplates.id, x.id), eq(sequenceTemplates.active, true)));

export const PUT = route<Ctx>(async (req, { params }, me) => {
  const x = await load(params, me), b = await body(req);
  const set: Partial<typeof sequenceTemplates.$inferInsert> = {};
  for (const k of ["tone", "subject", "body"] as const) if (k in b) {
    if (typeof b[k] !== "string") throw new HttpError(400, "Ungültige Eingabe");
    set[k] = b[k];
  }
  if ("active" in b) {
    if (typeof b.active !== "boolean") throw new HttpError(400, "Ungültige Eingabe");
    if (!b.active && !(await others(x)).length) throw new HttpError(400, "Mindestens eine Variante muss aktiv bleiben");
    set.active = b.active;
  }
  if (set.active ?? x.active) {
    if (!(set.subject ?? x.subject).trim()) throw new HttpError(400, "Betreff fehlt");
    if (!(set.body ?? x.body).trim()) throw new HttpError(400, "Text fehlt");
  }
  /* edited text: the old Jev score no longer applies */
  if (set.subject !== undefined || set.body !== undefined) set.score = null;
  if (Object.keys(set).length) await db.update(sequenceTemplates).set(set).where(eq(sequenceTemplates.id, x.id));
});

export const DELETE = route<Ctx>(async (_req, { params }, me) => {
  const x = await load(params, me);
  if (x.active && !(await others(x)).length) throw new HttpError(400, "Mindestens eine Variante muss aktiv bleiben");
  await db.delete(sequenceTemplates).where(eq(sequenceTemplates.id, x.id));
});
