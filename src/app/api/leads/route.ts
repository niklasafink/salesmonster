import { desc, eq } from "drizzle-orm";
import { db, leads } from "@/db";
import { HttpError, qp, route, tenantBySlug } from "@/lib/api";
import { insertLeads, type LeadRow } from "@/lib/lead-import";

export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  const rows = await db.select({ id: leads.id, company: leads.company, first: leads.first, last: leads.last, role: leads.role, email: leads.email,
    city: leads.city, source: leads.source, status: leads.status, note: leads.note, createdAt: leads.createdAt })
    .from(leads).where(eq(leads.tenantId, t.id)).orderBy(desc(leads.createdAt), desc(leads.id));
  return { rows };
});

export const POST = route(async (req, _c, me) => {
  const { t: slug, rows, source } = await req.json() as { t: string; rows: LeadRow[]; source: string };
  const t = await tenantBySlug(slug, me);
  if (!rows?.length) throw new HttpError(400, "Keine Zeilen");
  return { n: (await insertLeads(t.id, rows, source)).length };
});
