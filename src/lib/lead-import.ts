import { eq } from "drizzle-orm";
import { db, leads } from "@/db";
import { hubspotKnown, hubspotToken } from "@/lib/hubspot";
import { norm } from "@/lib/outreach";

/* One imported row as the parser, the import dialog and MCP hand it over */
export type LeadRow = { co: string; p: string; role: string; email: string; web: string; city: string };
export type CheckedRow = LeadRow & { dup: string; extra: string };

/* One person per company gets the mail; further people at that company are kept as contacts.
   Only rows that add nothing new (same address, or a known company without an address) are dropped. */
export async function checkLeads(tenantId: number, rows: LeadRow[]): Promise<CheckedRow[]> {
  const prev = await db.select({ c: leads.company, e: leads.email }).from(leads).where(eq(leads.tenantId, tenantId));
  const companies = new Set(prev.map(r => norm(r.c))), emails = new Set(prev.map(r => r.e.toLowerCase()).filter(Boolean));
  const hub = await hubspotToken(tenantId);
  const inHub = await Promise.all(rows.map(r => hub ? hubspotKnown(hub, r.co, r.web, r.email).catch(() => null) : null));
  return rows.map((r, i) => {
    const email = (r.email || "").toLowerCase(), known = companies.has(norm(r.co)) || !!inHub[i];
    const dup = email && emails.has(email) ? "Schon in der Liste" : inHub[i]?.why === "Kontakt in HubSpot" ? "Kontakt in HubSpot" : known && !email ? "Firma bekannt" : "";
    const extra = !dup && known ? "Weiterer Kontakt" : "";
    companies.add(norm(r.co)); if (email) emails.add(email);
    return { ...r, dup, extra };
  });
}

/* Inserts rows as given (the dialog already left out duplicates) */
export async function insertLeads(tenantId: number, rows: LeadRow[], source: string) {
  if (!rows.length) return [];
  const vals = rows.map(r => {
    const [first, ...rest] = (r.p || "").trim().split(/\s+/);
    const info = /^(info|kontakt|office|mail|post|service|vertrieb|hallo)@/i.test(r.email || "");
    return { tenantId, company: r.co.trim(), first: r.p ? first : "", last: r.p ? rest.join(" ") : "", role: r.role || "",
      email: (r.email || "").trim(), emailType: info || !r.p ? "info" : "person", website: r.web ? (r.web.startsWith("http") ? r.web : `https://${r.web}`) : "",
      city: r.city || "", source: source || "Import", status: "neu" };
  });
  return db.insert(leads).values(vals).returning({ id: leads.id, company: leads.company });
}

/* Check and insert in one go, for callers without a preview step */
export async function addLeads(tenantId: number, rows: LeadRow[], source: string) {
  const checked = await checkLeads(tenantId, rows);
  const added = await insertLeads(tenantId, checked.filter(r => !r.dup), source);
  return { added, skipped: checked.filter(r => r.dup).map(r => ({ company: r.co, why: r.dup })) };
}
