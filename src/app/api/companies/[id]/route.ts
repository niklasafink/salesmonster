import { eq } from "drizzle-orm";
import { companies, db } from "@/db";
import { HttpError, assertMember, route } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/* How the contacts of a company are written to: einzeln, alle, or eine (to `email`) */
export const PATCH = route<Ctx>(async (req, { params }, me) => {
  const { mode, email } = await req.json() as { mode: string; email?: string };
  if (!["einzeln", "alle", "eine"].includes(mode)) throw new HttpError(400, "Unbekannte Einstellung");
  const [c] = await db.select().from(companies).where(eq(companies.id, Number((await params).id)));
  if (!c) throw new HttpError(404, "Firma nicht gefunden");
  await assertMember(me, c.tenantId, "Firma");
  await db.update(companies).set({ mode, email: mode === "eine" ? (email || "").trim() : c.email }).where(eq(companies.id, c.id));
});
