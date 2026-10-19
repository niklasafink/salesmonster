import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, leads, messages, tenants } from "@/db";
import { addDaysIso, berlinDate, berlinWeekday } from "./dates";
import { getInteg } from "./integrations";
import { channelOf, domain } from "./lead-rating";
import { batchDays, draftDay, isSendDay, planOf, sendDayFrom, type SendPlan } from "./schedule";

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

/* A company's contacts in pieces of at most n, so no run and no send day takes more than n people */
const pieces = (ids: number[], n: number) => Array.from({ length: Math.ceil(ids.length / n) }, (_, i) => ids.slice(i * n, (i + 1) * n));

/* The queue cut into evening runs of n people each; a company that no longer fits starts the next run, one bigger than a run is split */
export function batches(q: QueueLead[], n: number) {
  const out: number[][] = [];
  for (const g of byCompany(q)) for (const ids of pieces(g.ids, n)) { const last = out.at(-1); if (last && last.length + ids.length <= n) last.push(...ids); else out.push([...ids]); }
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

export const perDay = (t: Tenant) => Math.max(1, Math.min(30, t.settings.leadsPerDay || 10));

/* Send days from `first` on with room for n people each. Returns the day for k people, not before `from`: the current day while it has room,
   else the next; a message bigger than a whole day takes an empty one */
function dayFiller(p: SendPlan, first: string, n: number) {
  const days = [{ day: first, left: n }];
  let i = 0;
  return (k: number, from = first) => {
    while (days[i].day < from || (days[i].left < k && days[i].left < n)) if (++i === days.length) days.push({ day: sendDayFrom(p, addDaysIso(days[i - 1].day, 1)), left: n });
    days[i].left -= k;
    return days[i].day;
  };
}

/* People mailed today, they count against today's limit */
export async function sentToday(tenantId: number, now = new Date()) {
  const rows = await db.select({ leadId: messages.leadId, leadIds: messages.leadIds }).from(messages)
    .where(and(eq(messages.tenantId, tenantId), eq(messages.channel, "mail"), eq(messages.status, "gesendet"), sql`(${messages.sentAt} at time zone 'Europe/Berlin')::date = ${berlinDate(now)}`));
  return rows.reduce((s, m) => s + (m.leadIds?.length || 1), 0);
}

/* Waiting mail drafts on the send days ahead, oldest first and leadsPerDay people per day: what has piled up spills onto the following days */
async function draftPlan(t: Tenant, now: Date) {
  const p = planOf(t.settings), n = perDay(t), today = berlinDate(now), first = draftDay(p, addDaysIso(today, -1), now);
  const drafts = await db.select({ leadId: messages.leadId, leadIds: messages.leadIds, batchDate: messages.batchDate, channel: messages.channel }).from(messages)
    .where(and(eq(messages.tenantId, t.id), inArray(messages.status, ["entwurf", "freigegeben"]))).orderBy(asc(messages.id));
  const put = dayFiller(p, first, n), out: Record<number, string> = {};
  if (first === today && isSendDay(p, today)) { const sent = await sentToday(t.id, now); if (sent) put(Math.min(sent, n)); }
  for (const m of drafts) if (m.channel === "mail") { const ids = m.leadIds?.length ? m.leadIds : [m.leadId], d = put(ids.length); for (const id of ids) out[id] = d; }
  return { p, n, today, put, out, ranToday: drafts.some(m => m.batchDate === today) };
}

/* How many people tonight's run may still draft: the day it fills keeps leadsPerDay, minus what is already waiting for that day */
export async function roomTonight(t: Tenant, now = new Date()) {
  const { p, n, today, out } = await draftPlan(t, now), day = draftDay(p, today, now);
  const days = Object.values(out);
  return days.some(d => d > day) ? 0 : Math.max(0, n - days.filter(d => d === day).length);
}

/* The day each lead is written to: waiting drafts first, then the queue, leadsPerDay people per send day; the queue starts on the day
   the next evening run fills. Mail in queue order, LinkedIn separately in campaign order */
export async function sendDates(t: Tenant, q: QueueLead[], li: number[] = [], now = new Date()) {
  const { p, n, put, out, ranToday } = await draftPlan(t, now);
  const from = batchDays(p, 1, ranToday, now)[0];
  for (const g of byCompany(q)) for (const ids of pieces(g.ids.filter(id => !out[id]), n)) if (ids.length) { const d = put(ids.length, from); for (const id of ids) out[id] = d; }
  const liPut = dayFiller(p, from, n);
  for (const id of li) if (!out[id]) out[id] = liPut(1);
  return out;
}

/* New order from drag and drop: the given ids get places 1…, the rest of the queue loses its place and follows by rating */
export async function setQueue(tenantId: number, ids: number[]) {
  await db.update(leads).set({ queueRank: null }).where(and(eq(leads.tenantId, tenantId), isNotNull(leads.queueRank)));
  if (!ids.length) return;
  const rank = sql.join(ids.map((id, i) => sql`when ${id} then ${i + 1}`), sql` `);
  await db.update(leads).set({ queueRank: sql`(case ${leads.id} ${rank} end)::int` }).where(and(eq(leads.tenantId, tenantId), inArray(leads.id, ids)));
}
