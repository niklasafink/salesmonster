import { asc, desc, eq } from "drizzle-orm";
import { companies, db, leads } from "@/db";
import { HttpError, checkEmail, qp, route, tenantBySlug } from "@/lib/api";
import { attachCompanies } from "@/lib/companies";
import { LEAD_FIELDS, cleanLead, httpUrl, salutationOf } from "@/lib/lead-fields";

export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  await attachCompanies(t.id);
  const rows = await db.select().from(leads).where(eq(leads.tenantId, t.id)).orderBy(desc(leads.createdAt), asc(leads.id));
  const cos = await db.select({ id: companies.id, name: companies.name, mode: companies.mode, email: companies.email }).from(companies).where(eq(companies.tenantId, t.id));
  return { rows: rows.map(r => ({ id: r.id, companyId: r.companyId, status: r.status, source: r.source, tenders: r.tenders, createdAt: r.createdAt, ...Object.fromEntries(LEAD_FIELDS.map(k => [k, r[k]])) })), companies: cos };
});

type Row = { co: string; sal?: string; p: string; role: string; email: string; web: string; city: string; li?: string; hook?: string };

/* Import (rows) or one new contact (lead) */
export const POST = route(async (req, _c, me) => {
  const { t: slug, rows, source, lead } = await req.json() as { t: string; rows?: Row[]; source?: string; lead?: Record<string, string> };
  const t = await tenantBySlug(slug, me);
  if (lead) {
    const v = cleanLead(lead);
    if (!v.company) throw new HttpError(400, "Firma fehlt");
    await checkEmail(t.id, v.email);
    const [r] = await db.insert(leads).values({ ...v, tenantId: t.id, company: v.company, source: "Manuell", status: "neu" }).returning();
    await attachCompanies(t.id);
    return { id: r.id };
  }
  if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, "Keine Zeilen");
  if (rows.some(r => !r || typeof r !== "object" || typeof r.co !== "string" || !r.co.trim())) throw new HttpError(400, "Firma fehlt in einer Zeile");
  const vals = rows.map(r => {
    const [first, ...rest] = (r.p || "").trim().split(/\s+/);
    const info = /^(info|kontakt|office|mail|post|service|vertrieb|hallo)@/i.test(r.email || "");
    return { tenantId: t.id, company: r.co.trim(), first: r.p ? first : "", last: r.p ? rest.join(" ") : "", role: r.role || "",
      email: (r.email || "").trim(), emailType: info || !r.p ? "info" : "person", website: httpUrl(r.web || ""),
      city: r.city || "", salutation: salutationOf(r.sal || ""), linkedin: httpUrl(r.li || ""), hook: r.hook || "", source: source || "Import", status: "neu" };
  });
  await db.insert(leads).values(vals);
  await attachCompanies(t.id);
  return { n: vals.length };
});
