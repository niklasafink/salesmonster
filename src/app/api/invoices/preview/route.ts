import type { InvoiceCustomer } from "@/db";
import { HttpError, route, tenantBySlug, tenantMembers } from "@/lib/api";
import { addDaysIso, berlinDate } from "@/lib/dates";
import { buildLines } from "@/lib/invoice-calc";
import { ciiXml, invoicePdf, type InvoiceData } from "@/lib/invoice-doc";

/* The unsaved form as the real PDF, shown in the browser's PDF viewer next to the form */
export const POST = route(async (req, _c, me) => {
  const b = await req.json() as { t: string; customer: InvoiceCustomer; plan: string; cycle: "monat" | "jahr"; price: number; start: string; dueDays: number; format: "zugferd" | "xrechnung"; leitweg: string; contactId: number };
  const t = await tenantBySlug(b.t, me);
  if (!t.invoice) throw new HttpError(400, "Rechnungen sind für diesen Mandanten nicht eingerichtet");
  const plan = t.invoice.plans.find(p => p.key === b.plan);
  if (!plan) throw new HttpError(400, "Tarif unbekannt");
  const issue = berlinDate(), start = /^\d{4}-\d{2}-\d{2}$/.test(b.start) ? b.start : issue;
  const contact = (await tenantMembers(t.id)).find(u => u.id === b.contactId) || me;
  const { lines, end } = buildLines({ plan, cycle: b.cycle, price: Math.max(0, Number(b.price) || 0), start });
  const data: InvoiceData = {
    number: `${issue.slice(0, 4)}-${t.invoice.nextNo}`, issueDate: issue, dueDate: addDaysIso(issue, Number(b.dueDays) || 14), serviceStart: start, serviceEnd: end,
    format: b.format, leitweg: b.leitweg || "", customer: b.customer, lines,
    contact: { name: contact.name, phone: contact.phone, email: contact.email }, settings: t.invoice,
  };
  const pdf = await invoicePdf(data, ciiXml(data));
  return new Response(new Uint8Array(pdf), { headers: { "content-type": "application/pdf", "cache-control": "no-store" } });
});
