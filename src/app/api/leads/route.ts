import { asc, desc, eq } from "drizzle-orm";
import { companies, db, leads } from "@/db";
import { HttpError, qp, route, tenantBySlug } from "@/lib/api";
import { attachCompanies } from "@/lib/companies";
import { LEAD_FIELDS, cleanLead } from "@/lib/lead-fields";
import { insertLeads, type LeadRow } from "@/lib/lead-import";

export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  await attachCompanies(t.id);
  const rows = await db.select().from(leads).where(eq(leads.tenantId, t.id)).orderBy(desc(leads.createdAt), asc(leads.id));
  const cos = await db.select({ id: companies.id, name: companies.name, mode: companies.mode, email: companies.email }).from(companies).where(eq(companies.tenantId, t.id));
  return { rows: rows.map(r => ({ id: r.id, companyId: r.companyId, status: r.status, source: r.source, tenders: r.tenders, createdAt: r.createdAt, ...Object.fromEntries(LEAD_FIELDS.map(k => [k, r[k]])) })), companies: cos };
});

/* Import (rows) or one new contact (lead) */
export const POST = route(async (req, _c, me) => {
  const { t: slug, rows, source, lead } = await req.json() as { t: string; rows?: LeadRow[]; source?: string; lead?: Record<string, string> };
  const t = await tenantBySlug(slug, me);
  if (lead) {
    const v = cleanLead(lead);
    if (!v.company) throw new HttpError(400, "Firma fehlt");
    const [r] = await db.insert(leads).values({ ...v, tenantId: t.id, company: v.company, source: "Manuell", status: "neu" }).returning();
    await attachCompanies(t.id);
    return { id: r.id };
  }
  if (!rows?.length) throw new HttpError(400, "Keine Zeilen");
  return { n: (await insertLeads(t.id, rows, source || "Import")).length };
});
