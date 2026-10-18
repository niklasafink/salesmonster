import { and, eq, ne } from "drizzle-orm";
import { db, templates } from "@/db";
import { HttpError, assertMember, body, idOf, route } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export const PUT = route<Ctx>(async (req, { params }, me) => {
  const id = await idOf(params, "Vorlage"), b = await body(req);
  const [t] = await db.select().from(templates).where(eq(templates.id, id));
  if (!t) throw new HttpError(404, "Vorlage nicht gefunden");
  await assertMember(me, t.tenantId, "Vorlage");
  if (b.active === false) {
    const others = await db.select().from(templates).where(and(eq(templates.tenantId, t.tenantId), ne(templates.id, id), eq(templates.active, true)));
    if (!others.length) throw new HttpError(400, "Mindestens eine Variante muss aktiv bleiben");
  }
  const set: Partial<typeof templates.$inferInsert> = {};
  for (const k of ["name", "tone", "subject", "body"] as const) if (k in b) {
    if (typeof b[k] !== "string") throw new HttpError(400, "Ungültige Eingabe");
    set[k] = b[k];
  }
  if ("active" in b) {
    if (typeof b.active !== "boolean") throw new HttpError(400, "Ungültige Eingabe");
    set.active = b.active;
  }
  if (!Object.keys(set).length) return;
  if (set.active ?? t.active) {
    if (!(set.subject ?? t.subject).trim()) throw new HttpError(400, "Betreff fehlt");
    if (!(set.body ?? t.body).trim()) throw new HttpError(400, "Text fehlt");
  }
  await db.update(templates).set(set).where(eq(templates.id, id));
});
