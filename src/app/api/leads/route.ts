import { asc, desc, eq, sql } from "drizzle-orm";
import { companies, db, leads } from "@/db";
import { HttpError, checkEmail, qp, route, tenantBySlug } from "@/lib/api";
import { attachCompanies } from "@/lib/companies";
import { LEAD_FIELDS, cleanLead } from "@/lib/lead-fields";
import { insertLeads, type LeadRow } from "@/lib/lead-import";
import { fitPending, later, refreshRatings, rerate } from "@/lib/ratings";

export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  await attachCompanies(t.id);
  /* ratings age with their trigger, so they are brought up to date whenever the list is read */
  await rerate(t.id);
  /* what the AI has not judged yet is judged after the answer; the next read shows it */
  await fitPending(t.id);
  const rows = await db.select().from(leads).where(eq(leads.tenantId, t.id)).orderBy(sql`${leads.rating} desc nulls last`, desc(leads.createdAt), asc(leads.id));
  const cos = await db.select({ id: companies.id, name: companies.name, mode: companies.mode, email: companies.email }).from(companies).where(eq(companies.tenantId, t.id));
  return { rows: rows.map(r => ({ id: r.id, companyId: r.companyId, status: r.status, source: r.source, tenders: r.tenders, createdAt: r.createdAt, lastContactAt: r.lastContactAt, rating: r.rating, ratingInfo: r.ratingInfo, vote: r.vote, fit: r.fit, angleId: r.angleId, ...Object.fromEntries(LEAD_FIELDS.map(k => [k, r[k]])) })), companies: cos };
});

/* Import (rows) or one new contact (lead) */
export const POST = route(async (req, _c, me) => {
  const { t: slug, rows, source, lead } = await req.json() as { t: string; rows?: LeadRow[]; source?: string; lead?: Record<string, string> };
  const t = await tenantBySlug(slug, me);
  if (lead) {
    const v = cleanLead(lead);
    if (!v.company) throw new HttpError(400, "Firma fehlt");
    await checkEmail(t.id, v.email);
    const [r] = await db.insert(leads).values({ ...v, tenantId: t.id, company: v.company, source: "Manuell", status: "neu" }).returning();
    await attachCompanies(t.id);
    await later(() => refreshRatings(t.id, [r.id]));
    return { id: r.id };
  }
  if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, "Keine Zeilen");
  if (rows.some(r => !r || typeof r !== "object" || typeof r.co !== "string" || !r.co.trim())) throw new HttpError(400, "Firma fehlt in einer Zeile");
  const added = await insertLeads(t.id, rows, source || "Import");
  await later(() => refreshRatings(t.id, added.map(a => a.id)));
  return { n: added.length };
});
