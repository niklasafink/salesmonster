import { eq } from "drizzle-orm";
import { angles, db } from "@/db";
import { HttpError, assertMember, body, idOf, route } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, { params }, me) => {
  const id = await idOf(params, "Suchrichtung"), b = await body(req);
  const [a] = await db.select().from(angles).where(eq(angles.id, id));
  if (!a) throw new HttpError(404, "Suchrichtung nicht gefunden");
  await assertMember(me, a.tenantId, "Suchrichtung");
  const set: Partial<typeof angles.$inferInsert> = {};
  if ("active" in b) { if (typeof b.active !== "boolean") throw new HttpError(400, "Ungültige Eingabe"); set.active = b.active; }
  for (const k of ["label", "query"] as const) if (k in b) {
    if (typeof b[k] !== "string") throw new HttpError(400, "Ungültige Eingabe");
    set[k] = (b[k] as string).trim().slice(0, k === "label" ? 80 : 400);
  }
  if (set.label === "") throw new HttpError(400, "Name fehlt");
  if (Object.keys(set).length) await db.update(angles).set(set).where(eq(angles.id, id));
});
