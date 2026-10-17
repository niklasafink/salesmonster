import { eq } from "drizzle-orm";
import { db, invoices } from "@/db";
import { HttpError, assertMember, route } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, { params }, me) => {
  const { status } = await req.json();
  if (!["offen", "bezahlt", "überfällig", "storniert"].includes(status)) throw new HttpError(400, "Unbekannter Status");
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, Number((await params).id)));
  if (!inv) throw new HttpError(404, "Rechnung nicht gefunden");
  await assertMember(me, inv.tenantId, "Rechnung");
  await db.update(invoices).set({ status }).where(eq(invoices.id, inv.id));
});
