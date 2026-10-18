import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, leads, messages, tenants } from "@/db";
import { berlinDate, berlinWeekday } from "./dates";
import { getInteg } from "./integrations";
import { channelOf, domain } from "./lead-rating";
import { batchDays, draftDay, planOf } from "./schedule";

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

/* The queue by company, in order: a company's open contacts are written to on the same evening */
export function byCompany(q: QueueLead[]) {
  const out = new Map<number | string, { companyId: number | null; ids: number[]; held: boolean }>();
  for (const r of q) {
    const k = r.companyId ?? `l${r.id}`, g = out.get(k);
    if (g) g.ids.push(r.id); else out.set(k, { companyId: r.companyId, ids: [r.id], held: r.held });
  }
  return [...out.values()];
}

/* The queue cut into evening runs of n people each; a company that no longer fits starts the next run */
export function batches(q: QueueLead[], n: number) {
  const out: number[][] = [];
  for (const g of byCompany(q)) { const last = out.at(-1); if (last && last.length + g.ids.length <= n) last.push(...g.ids); else out.push([...g.ids]); }
  return out;
}

/* What the next evening run turns into drafts */
export const nextUp = (q: QueueLead[], n: number) => batches(q, n)[0] ?? [];

/* LinkedIn leads in the order the evening run hands them to the SendPilot campaign; empty without a campaign, then they wait for the LinkedIn button */
export async function liQueue(t: Tenant) {
  if (!t.settings.sendpilotCampaign || !await linkedinOn(t.id)) return [];
  const bounced = await bouncedDomains(t.id);
  const open = await db.select().from(leads).where(and(eq(leads.tenantId, t.id), eq(leads.status, "neu"), sql`${leads.sendpilotAt} is null`))
    .orderBy(sql`${leads.queueRank} asc nulls last`, sql`${leads.rating} desc nulls last`, asc(leads.createdAt), asc(leads.id));
  return open.filter(l => channelOf(l, bounced).ch === "linkedin").map(l => l.id);
}

/* The day each lead is written to: drafts go out on the send day after their evening, the queue fills one evening run per send day
   with leadsPerDay people on each channel, mail in queue order and LinkedIn in campaign order */
export async function sendDates(t: Tenant, q: QueueLead[], li: number[] = [], now = new Date()) {
  const p = planOf(t.settings), n = Math.max(1, Math.min(30, t.settings.leadsPerDay || 10)), today = berlinDate(now);
  const drafts = await db.select({ leadId: messages.leadId, leadIds: messages.leadIds, batchDate: messages.batchDate, channel: messages.channel }).from(messages)
    .where(and(eq(messages.tenantId, t.id), inArray(messages.status, ["entwurf", "freigegeben"])));
  const out: Record<number, string> = {};
  for (const m of drafts) if (m.channel === "mail") for (const id of m.leadIds?.length ? m.leadIds : [m.leadId]) out[id] = draftDay(p, m.batchDate, now);
  const runs = batches(q, n), liRuns = Array.from({ length: Math.ceil(li.length / n) }, (_, i) => li.slice(i * n, (i + 1) * n));
  const days = batchDays(p, Math.max(runs.length, liRuns.length), drafts.some(m => m.batchDate === today), now);
  for (const rs of [runs, liRuns]) rs.forEach((ids, i) => { for (const id of ids) if (days[i] && !out[id]) out[id] = days[i]; });
  return out;
}

/* New order from drag and drop: the given ids get places 1…, the rest of the queue loses its place and follows by rating */
export async function setQueue(tenantId: number, ids: number[]) {
  await db.update(leads).set({ queueRank: null }).where(and(eq(leads.tenantId, tenantId), isNotNull(leads.queueRank)));
  if (!ids.length) return;
  const rank = sql.join(ids.map((id, i) => sql`when ${id} then ${i + 1}`), sql` `);
  await db.update(leads).set({ queueRank: sql`(case ${leads.id} ${rank} end)::int` }).where(and(eq(leads.tenantId, tenantId), inArray(leads.id, ids)));
}
