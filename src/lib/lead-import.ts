import { eq, inArray } from "drizzle-orm";
import { db, leads } from "@/db";
import { attachCompanies, norm } from "@/lib/companies";
import { hubspotKnown, hubspotToken } from "@/lib/hubspot";
import { getInteg } from "@/lib/integrations";
import { guessSalutations } from "@/lib/jev";
import { salutationOf } from "@/lib/lead-fields";

/* One imported contact as the parser, the import dialog and MCP hand it over; several rows with the same co are contacts of one company */
export type LeadRow = { co: string; sal?: string; p: string; role: string; email: string; web: string; city: string; li?: string; hook?: string; url?: string };
export type CheckedRow = LeadRow & { sal: string; dup: string; extra: string };
/* Company mailboxes rather than a person's address */
export const INFO_MAIL = /^(info|kontakt|office|mail|post|service|vertrieb|hallo)@/i;

/* One person per company gets the mail; further people at that company are kept as contacts.
   Only rows that add nothing new (same address, or a known company without an address) are dropped. */
export async function checkLeads(tenantId: number, rows: LeadRow[]): Promise<CheckedRow[]> {
  const prev = await db.select({ c: leads.company, e: leads.email }).from(leads).where(eq(leads.tenantId, tenantId));
  const companies = new Set(prev.map(r => norm(r.c))), emails = new Set(prev.map(r => r.e.toLowerCase()).filter(Boolean));
  const hub = await hubspotToken(tenantId);
  const inHub = await Promise.all(rows.map(r => hub ? hubspotKnown(hub, r.co, r.web, r.email).catch(() => null) : null));
  const out = rows.map((r, i) => {
    const email = (r.email || "").toLowerCase(), known = companies.has(norm(r.co)) || !!inHub[i];
    const dup = email && emails.has(email) ? "Schon in der Liste" : inHub[i]?.why === "Kontakt in HubSpot" ? "Kontakt in HubSpot" : known && !email ? "Firma bekannt" : "";
    const extra = !dup && known ? "Weiterer Kontakt" : "";
    companies.add(norm(r.co)); if (email) emails.add(email);
    return { ...r, sal: salutationOf(r.sal || ""), dup, extra };
  });
  /* No Herr/Frau in the source: Jev guesses from name and role, a title found in the text is kept */
  const open = out.map((r, i) => i).filter(i => out[i].p && !out[i].sal);
  const jev = open.length ? await getInteg(tenantId, "jev") : null;
  if (jev) {
    const g = await guessSalutations(jev.key || "", open.map(i => { const [first, ...rest] = out[i].p.trim().split(/\s+/); return { first, last: rest.join(" "), role: out[i].role }; })).catch(() => []);
    open.forEach((i, k) => { if (g[k]) out[i].sal = salutationOf(`${g[k]} ${rows[i].sal || ""}`); });
  }
  return out;
}

/* Inserts rows as given (the dialog already left out duplicates) and files them under their company */
export async function insertLeads(tenantId: number, rows: LeadRow[], source: string) {
  if (!rows.length) return [];
  const vals = rows.map(r => {
    const [first, ...rest] = (r.p || "").trim().split(/\s+/);
    const info = INFO_MAIL.test(r.email || "");
    return { tenantId, company: r.co.trim(), first: r.p ? first : "", last: r.p ? rest.join(" ") : "", role: r.role || "",
      email: (r.email || "").trim(), emailType: info || !r.p ? "info" : "person", website: r.web ? (r.web.startsWith("http") ? r.web : `https://${r.web}`) : "",
      city: r.city || "", salutation: salutationOf(r.sal || ""), linkedin: r.li || "", hook: r.hook || "", sourceUrl: r.url || "", source: source || "Import", status: "neu" };
  });
  const ids = (await db.insert(leads).values(vals).returning({ id: leads.id })).map(r => r.id);
  await attachCompanies(tenantId);
  const got = new Map((await db.select({ id: leads.id, company: leads.company, companyId: leads.companyId }).from(leads).where(inArray(leads.id, ids))).map(r => [r.id, r]));
  return ids.map(id => got.get(id)!);
}

/* Check and insert in one go, for callers without a preview step */
export async function addLeads(tenantId: number, rows: LeadRow[], source: string) {
  const checked = await checkLeads(tenantId, rows);
  const added = await insertLeads(tenantId, checked.filter(r => !r.dup), source);
  return { added, skipped: checked.filter(r => r.dup).map(r => ({ company: r.co, why: r.dup })) };
}
