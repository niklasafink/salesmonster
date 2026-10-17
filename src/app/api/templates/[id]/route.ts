import { and, eq, ne } from "drizzle-orm";
import { db, templates } from "@/db";
import { HttpError, assertMember, route } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export const PUT = route<Ctx>(async (req, { params }, me) => {
  const id = Number((await params).id), b = await req.json();
  const [t] = await db.select().from(templates).where(eq(templates.id, id));
  if (!t) throw new HttpError(404, "Vorlage nicht gefunden");
  await assertMember(me, t.tenantId, "Vorlage");
  if (b.active === false) {
    const others = await db.select().from(templates).where(and(eq(templates.tenantId, t.tenantId), ne(templates.id, id), eq(templates.active, true)));
    if (!others.length) throw new HttpError(400, "Mindestens eine Variante muss aktiv bleiben");
  }
  const set: Partial<typeof templates.$inferInsert> = {};
  for (const k of ["name", "tone", "subject", "body", "active"] as const) if (k in b) (set as Record<string, unknown>)[k] = b[k];
  await db.update(templates).set(set).where(eq(templates.id, id));
});
