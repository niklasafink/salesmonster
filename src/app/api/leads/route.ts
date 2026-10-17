import { desc, eq } from "drizzle-orm";
import { db, leads } from "@/db";
import { HttpError, qp, route, tenantBySlug } from "@/lib/api";

export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  const rows = await db.select({ id: leads.id, company: leads.company, first: leads.first, last: leads.last, role: leads.role, email: leads.email,
    city: leads.city, source: leads.source, status: leads.status, note: leads.note, createdAt: leads.createdAt })
    .from(leads).where(eq(leads.tenantId, t.id)).orderBy(desc(leads.createdAt), desc(leads.id));
  return { rows };
});

type Row = { co: string; p: string; role: string; email: string; web: string; city: string };

export const POST = route(async (req, _c, me) => {
  const { t: slug, rows, source } = await req.json() as { t: string; rows: Row[]; source: string };
  const t = await tenantBySlug(slug, me);
  if (!rows?.length) throw new HttpError(400, "Keine Zeilen");
  const vals = rows.map(r => {
    const [first, ...rest] = (r.p || "").trim().split(/\s+/);
    const info = /^(info|kontakt|office|mail|post|service|vertrieb|hallo)@/i.test(r.email || "");
    return { tenantId: t.id, company: r.co.trim(), first: r.p ? first : "", last: r.p ? rest.join(" ") : "", role: r.role || "",
      email: (r.email || "").trim(), emailType: info || !r.p ? "info" : "person", website: r.web ? (r.web.startsWith("http") ? r.web : `https://${r.web}`) : "",
      city: r.city || "", source: source || "Import", status: "neu" };
  });
  await db.insert(leads).values(vals);
  return { n: vals.length };
});
