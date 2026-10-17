import { and, desc, eq, ilike, or } from "drizzle-orm";
import { db, invoices, leads } from "@/db";
import { qp, route, tenantBySlug } from "@/lib/api";
import { hubspotCompanies, hubspotToken } from "@/lib/hubspot";

/* HubSpot first, then earlier invoice recipients and leads */
export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  const q = (qp(req, "q") || "").trim();
  const hub = await hubspotToken(t.id);
  const out: { src: "hs" | "inv" | "lead"; co: string; domain: string; street: string; zip: string; city: string; contact: string; email: string; salut: string; vat: string }[] = [];
  if (hub && q.length >= 2) {
    try { (await hubspotCompanies(hub, q)).forEach(c => out.push({ src: "hs", ...c, vat: "" })); } catch (e) { console.error(e); }
  }
  const like = `%${q}%`;
  const prev = await db.select({ c: invoices.customer }).from(invoices).where(eq(invoices.tenantId, t.id)).orderBy(desc(invoices.createdAt)).limit(200);
  const seen = new Set(out.map(o => o.co.toLowerCase()));
  for (const { c } of prev) {
    if (seen.has(c.co.toLowerCase()) || (q && !`${c.co} ${c.domain} ${c.attn}`.toLowerCase().includes(q.toLowerCase()))) continue;
    seen.add(c.co.toLowerCase());
    out.push({ src: "inv", co: c.co, domain: c.domain, street: c.street, zip: c.zip, city: c.city, contact: c.attn, email: c.email, salut: c.salut, vat: c.vat });
  }
  const ls = await db.select().from(leads).where(and(eq(leads.tenantId, t.id), q ? or(ilike(leads.company, like), ilike(leads.email, like), ilike(leads.last, like)) : undefined))
    .orderBy(desc(leads.createdAt)).limit(10);
  for (const l of ls) {
    if (seen.has(l.company.toLowerCase())) continue;
    seen.add(l.company.toLowerCase());
    out.push({ src: "lead", co: l.company, domain: l.website.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0], street: "", zip: "", city: l.city,
      contact: [l.first, l.last].filter(Boolean).join(" "), email: l.email, salut: l.salutation && l.last ? `${l.salutation} ${l.last}` : "", vat: "" });
  }
  return { rows: out.slice(0, 12), hubspot: !!hub };
});
