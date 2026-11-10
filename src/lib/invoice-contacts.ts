import { tenantMembers } from "./api";

type Contact = { id: number; name: string; short: string; email: string; phone: string };

/* Contacts for the invoice's "Kontakt" block besides the tenant's members: only a name, mail and phone, no login.
   Negative ids, so they never clash with a user; an invoice keeps such a contact as a copy in its customer data. */
const FIXED: Record<string, Contact[]> = {
  vh: [{ id: -1, name: "Lasse Schröder", short: "Lasse", email: "lasse@vergabehero.eu", phone: "+49 (0) 1517 0007928" }],
};

export const fixedContacts = (slug: string) => FIXED[slug] || [];

export async function invoiceContact(t: { id: number; slug: string }, id: number) {
  return [...await tenantMembers(t.id), ...fixedContacts(t.slug)].find(c => c.id === id);
}
