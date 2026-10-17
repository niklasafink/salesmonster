import { eq } from "drizzle-orm";
import { db, invoices, tenants, users } from "@/db";
import { HttpError, assertMember } from "./api";
import { ciiXml, invoicePdf, type InvoiceData } from "./invoice-doc";

export async function loadInvoice(id: number, user: { id: number }) {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
  if (!inv) throw new HttpError(404, "Rechnung nicht gefunden");
  await assertMember(user, inv.tenantId, "Rechnung");
  const [t] = await db.select().from(tenants).where(eq(tenants.id, inv.tenantId));
  const [u] = inv.contactId ? await db.select().from(users).where(eq(users.id, inv.contactId)) : [];
  if (!t.invoice) throw new HttpError(400, "Rechnungen nicht eingerichtet");
  const data: InvoiceData = {
    number: inv.number, issueDate: inv.issueDate, dueDate: inv.dueDate, serviceStart: inv.serviceStart, serviceEnd: inv.serviceEnd,
    format: inv.format as InvoiceData["format"], leitweg: inv.leitweg, customer: inv.customer, lines: inv.lines,
    contact: { name: u?.name || "", phone: u?.phone || "", email: u?.email || "" }, settings: t.invoice,
  };
  return { inv, tenant: t, data };
}

export async function invoiceFile(data: InvoiceData) {
  const xml = ciiXml(data);
  if (data.format === "xrechnung") return { filename: `Rechnung-${data.number}.xml`, content: Buffer.from(xml, "utf8"), contentType: "application/xml" };
  return { filename: `Rechnung-${data.number}.pdf`, content: Buffer.from(await invoicePdf(data, xml)), contentType: "application/pdf" };
}
