import { and, asc, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { companies, db, leads } from "@/db";
import { HttpError, checkEmail, qp, route, tenantBySlug } from "@/lib/api";
import { attachCompanies } from "@/lib/companies";
import { LEAD_FIELDS, cleanLead } from "@/lib/lead-fields";
import { fillLeads, insertLeads, type LeadRow } from "@/lib/lead-import";
import { fitPending, later, refreshRatings, rerate } from "@/lib/ratings";
import { channelOf } from "@/lib/lead-rating";
import { bouncedDomains, liQueue, mailQueue, nextUp, sendDates } from "@/lib/queue";

/* what the list shows of someone who is only in the CRM; the page fills in the rest (lib CRM_DEFAULTS in views/leads.tsx) */
const CRM_COLS = { id: leads.id, companyId: leads.companyId, company: leads.company, salutation: leads.salutation, first: leads.first, last: leads.last, role: leads.role, email: leads.email,
  phone: leads.phone, linkedin: leads.linkedin, website: leads.website, city: leads.city, status: leads.status, source: leads.source, crmAt: leads.crmAt, stage: leads.stage,
  hsContactId: leads.hsContactId, lastContactAt: leads.lastContactAt, createdAt: leads.createdAt, note: leads.note };

export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  await attachCompanies(t.id);
  /* ratings age with their trigger, so they are brought up to date whenever the list is read: after the answer, the next read shows
     them (the page reads again after changes); only ratings that changed are written */
  await later(() => rerate(t.id));
  /* what the AI has not judged yet is judged after the answer; the next read shows it */
  await fitPending(t.id);
  /* Leads come with everything the list works with, except what only the dialog shows (research text, the judge's reasons).
     People who are only in the CRM come with the columns the list shows: with ten thousand registrations that is most of the rows. */
  const { research: _r, fitInfo: _f, ...cols } = getTableColumns(leads);
  const [rows, crm, cos, bounced, queue] = await Promise.all([
    db.select(cols).from(leads).where(and(eq(leads.tenantId, t.id), eq(leads.prospect, true))).orderBy(sql`${leads.rating} desc nulls last`, desc(leads.createdAt), asc(leads.id)),
    db.select(CRM_COLS).from(leads).where(and(eq(leads.tenantId, t.id), eq(leads.prospect, false))).orderBy(desc(leads.crmAt), asc(leads.id)),
    db.select({ id: companies.id, name: companies.name, mode: companies.mode, email: companies.email, hubspotId: companies.hubspotId, domain: companies.domain }).from(companies).where(eq(companies.tenantId, t.id)),
    bouncedDomains(t.id), mailQueue(t)]);
  const keys = LEAD_FIELDS.filter(k => k !== "research");
  /* order = the whole mail queue in send order, next = the leads the next evening run drafts, days = when each is written to */
  return { order: queue.map(q => q.id), next: nextUp(queue, t.settings.leadsPerDay || 10), days: await sendDates(t, queue, await liQueue(t)), rows: rows.map(r => ({ id: r.id, channel: r.channel, channelRec: channelOf({ ...r, channel: "" }, bounced), sendpilotAt: r.sendpilotAt, companyId: r.companyId, status: r.status, source: r.source, tenders: r.tenders, createdAt: r.createdAt, lastContactAt: r.lastContactAt, rating: r.rating, ratingInfo: r.ratingInfo, vote: r.vote, enrichMiss: r.enrichMiss, fit: r.fit, angleId: r.angleId,
    prospect: r.prospect, crmAt: r.crmAt, stage: r.stage, hsContactId: r.hsContactId, ...Object.fromEntries(keys.map(k => [k, r[k]])) })), crm, companies: cos };
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
    /* a provisional rating right away, the AI's after the answer */
    await rerate(t.id);
    await later(() => refreshRatings(t.id, [r.id]));
    return { id: r.id };
  }
  if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, "Keine Zeilen");
  if (rows.some(r => !r || typeof r !== "object" || typeof r.co !== "string" || !r.co.trim())) throw new HttpError(400, "Firma fehlt in einer Zeile");
  /* rows with an id complete a lead that is already there */
  const fill = rows.filter((r): r is LeadRow & { id: number } => Number.isInteger((r as { id?: unknown }).id));
  const added = await insertLeads(t.id, rows.filter(r => !fill.includes(r as LeadRow & { id: number })), source || "Import");
  const filled = await fillLeads(t.id, fill);
  await rerate(t.id);
  await later(() => refreshRatings(t.id, [...added.map(a => a.id), ...filled]));
  return { n: added.length, filled: filled.length };
});
