import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, leads, tenants } from "@/db";
import { berlinWeekday } from "./dates";
import { getInteg } from "./integrations";
import { channelOf, domain } from "./lead-rating";

type Tenant = typeof tenants.$inferSelect;
export type QueueLead = { id: number; companyId: number | null; held: boolean };

/* Domains that already bounced in this tenant */
export async function bouncedDomains(tenantId: number) {
  const rows = await db.selectDistinct({ email: leads.email }).from(leads).where(and(eq(leads.tenantId, tenantId), eq(leads.status, "unzustellbar")));
  return [...new Set(rows.map(r => domain(r.email)).filter(Boolean))];
}

/* Whether the evening run hands LinkedIn leads to SendPilot instead of mailing them */
export const linkedinOn = async (tenantId: number) => !!await getInteg(tenantId, "sendpilot");

/* Open leads in the order the evening run drafts mails for them: the place set by drag and drop first, then the rating.
   Left out: leads that went to SendPilot and every contact of their company, and, with SendPilot connected, leads whose channel is LinkedIn.
   held = grade A waiting for Tuesday/Wednesday (holdTop); those come last and only fill the batch after new research. */
export async function mailQueue(t: Tenant, now = new Date()): Promise<QueueLead[]> {
  const tomorrow = berlinWeekday(new Date(now.getTime() + 864e5)), hold = !!t.settings.holdTop && !["Tue", "Wed"].includes(tomorrow);
  const rows = await db.select({ id: leads.id, companyId: leads.companyId, email: leads.email, emailType: leads.emailType, linkedin: leads.linkedin, channel: leads.channel,
    queueRank: leads.queueRank, grade: sql<string>`coalesce(${leads.ratingInfo}->>'grade', '')` }).from(leads)
    .where(and(eq(leads.tenantId, t.id), eq(leads.status, "neu"), sql`${leads.sendpilotAt} is null`))
    .orderBy(sql`${leads.queueRank} asc nulls last`, sql`${leads.rating} desc nulls last`, asc(leads.createdAt), asc(leads.id));
  const onLi = await linkedinOn(t.id), bounced = onLi ? await bouncedDomains(t.id) : [];
  const gone = new Set((await db.selectDistinct({ c: leads.companyId }).from(leads).where(and(eq(leads.tenantId, t.id), isNotNull(leads.sendpilotAt)))).map(r => r.c));
  const out = rows.filter(r => !gone.has(r.companyId) && !(onLi && channelOf(r, bounced).ch === "linkedin"))
    .map(r => ({ id: r.id, companyId: r.companyId, held: hold && r.grade === "A" && r.queueRank === null }));
  return [...out.filter(r => !r.held), ...out.filter(r => r.held)];
}

/* The leads of the next n companies: what the next evening run turns into drafts */
export function nextUp(q: QueueLead[], n: number) {
  const cos: (number | null)[] = [];
  return q.filter(r => { if (!cos.includes(r.companyId)) { if (cos.length >= n) return false; cos.push(r.companyId); } return true; }).map(r => r.id);
}

/* New order from drag and drop: the given ids get places 1…, the rest of the queue loses its place and follows by rating */
export async function setQueue(tenantId: number, ids: number[]) {
  await db.update(leads).set({ queueRank: null }).where(and(eq(leads.tenantId, tenantId), isNotNull(leads.queueRank)));
  if (!ids.length) return;
  const rank = sql.join(ids.map((id, i) => sql`when ${id} then ${i + 1}`), sql` `);
  await db.update(leads).set({ queueRank: sql`(case ${leads.id} ${rank} end)::int` }).where(and(eq(leads.tenantId, tenantId), inArray(leads.id, ids)));
}
