import { eq } from "drizzle-orm";
import { db, invoices } from "@/db";
import { HttpError, route } from "@/lib/api";
import { dLong } from "@/lib/dates";
import { eur, greeting, totalOf } from "@/lib/invoice-calc";
import { invoiceFile, loadInvoice } from "@/lib/invoice-store";
import { sendAs, sendSystem } from "@/lib/mail";

type Ctx = { params: Promise<{ id: string }> };

/* From the sender's own mailbox if connected, otherwise via Resend */
export const POST = route<Ctx>(async (_req, { params }, me) => {
  const { inv, tenant, data } = await loadInvoice(Number((await params).id), me);
  const to = data.customer.email;
  if (!to) throw new HttpError(400, "Empfänger-Adresse fehlt");
  const f = await invoiceFile(data);
  const mail = { to, subject: `Rechnung ${data.number}`, attachments: [f],
    text: `${greeting(data.customer.salut)}\n\nanbei erhalten Sie unsere Rechnung ${data.number} über ${eur(totalOf(data.lines))}, fällig am ${dLong(data.dueDate)}.\n\nMit freundlichen Grüßen\n${me.name}` };
  try { await sendAs(tenant.id, me.id, mail); }
  catch (e) {
    if ((e as Error).message !== "Kein Postfach verbunden") throw e;
    await sendSystem(tenant.id, mail).catch(() => { throw new HttpError(400, "Kein Postfach und kein Resend verbunden"); });
  }
  await db.update(invoices).set({ sentAt: new Date() }).where(eq(invoices.id, inv.id));
  return { to };
});
