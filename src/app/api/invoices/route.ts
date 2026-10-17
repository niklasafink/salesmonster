import { desc, eq } from "drizzle-orm";
import { db, invoices, tenants, type InvoiceCustomer } from "@/db";
import { HttpError, qp, route, tenantBySlug, tenantMembers } from "@/lib/api";
import { addDaysIso, berlinDate } from "@/lib/dates";
import { buildLines, totalOf } from "@/lib/invoice-calc";

export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  const rows = await db.select().from(invoices).where(eq(invoices.tenantId, t.id)).orderBy(desc(invoices.createdAt));
  return { rows: rows.map(r => ({ ...r, total: Number(r.total) })) };
});

export const POST = route(async (req, _c, me) => {
  const b = await req.json() as { t: string; customer: InvoiceCustomer; plan: string; cycle: "monat" | "jahr"; price: number; start: string; dueDays: number; format: "zugferd" | "xrechnung"; leitweg: string; contactId: number };
  const t = await tenantBySlug(b.t, me);
  if (!t.invoice) throw new HttpError(400, "Rechnungen sind für diesen Mandanten nicht eingerichtet");
  const plan = t.invoice.plans.find(p => p.key === b.plan);
  if (!plan) throw new HttpError(400, "Tarif unbekannt");
  const c = b.customer;
  for (const [k, n] of [["co", "Firma"], ["street", "Straße"], ["zip", "PLZ"], ["city", "Ort"]] as const) if (!String(c?.[k] || "").trim()) throw new HttpError(400, `${n} fehlt`);
  if (b.format === "xrechnung" && !b.leitweg) throw new HttpError(400, "Leitweg-ID fehlt");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.start)) throw new HttpError(400, "Leistungsbeginn fehlt");
  const contact = (await tenantMembers(t.id)).find(u => u.id === b.contactId);
  if (!contact) throw new HttpError(400, "Ansprechpartner fehlt");

  const { lines, end, item } = buildLines({ plan, cycle: b.cycle, price: Math.max(0, Number(b.price) || 0), start: b.start });
  const issue = berlinDate(), year = issue.slice(0, 4);
  const no = t.invoice.nextNo;
  await db.update(tenants).set({ invoice: { ...t.invoice, nextNo: no + 1 } }).where(eq(tenants.id, t.id));
  const [inv] = await db.insert(invoices).values({
    tenantId: t.id, number: `${year}-${no}`, customer: c, item, lines, total: String(totalOf(lines)),
    issueDate: issue, dueDate: addDaysIso(issue, Number(b.dueDays) || 14), serviceStart: b.start, serviceEnd: end,
    format: b.format, leitweg: b.leitweg || "", contactId: contact.id,
  }).returning();
  return { ...inv, total: Number(inv.total) };
});
