import { eq } from "drizzle-orm";
import { db, tenants } from "@/db";
import { HttpError, route, tenantBySlug } from "@/lib/api";

type Ctx = { params: Promise<{ slug: string }> };

export const PATCH = route<Ctx>(async (req, { params }, me) => {
  const t = await tenantBySlug((await params).slug, me), b = await req.json();
  const set: Partial<typeof tenants.$inferInsert> = {};
  if (b.settings) {
    const s = { ...t.settings, ...b.settings };
    s.leadsPerDay = Math.max(1, Math.min(30, Number(s.leadsPerDay) || 10));
    set.settings = s;
  }
  if (b.invoice) {
    if (!t.invoice) throw new HttpError(400, "Rechnungen sind für diesen Mandanten nicht eingerichtet");
    set.invoice = { ...t.invoice, ...b.invoice, seller: { ...t.invoice.seller, ...(b.invoice.seller || {}) } };
  }
  if (typeof b.tenders === "boolean") set.tenders = b.tenders;
  if (b.name) set.name = b.name;
  await db.update(tenants).set(set).where(eq(tenants.id, t.id));
});
