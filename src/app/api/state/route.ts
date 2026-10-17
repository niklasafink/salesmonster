import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, leads, members, messages, templates, tenants } from "@/db";
import { qp, route, tenantMembers } from "@/lib/api";
import { integStatus } from "@/lib/integrations";
import { lastRuns } from "@/lib/outreach";
import { mailboxOf, msConfigured } from "@/lib/mail";

export const GET = route(async (req, _c, me) => {
  const all = (await db.select({ t: tenants }).from(tenants).innerJoin(members, eq(members.tenantId, tenants.id))
    .where(eq(members.userId, me.id)).orderBy(asc(tenants.position), asc(tenants.id))).map(r => r.t);
  const t = all.find(x => x.slug === qp(req, "t")) || all[0];
  const people = t ? await tenantMembers(t.id) : [];
  const base = { me: { id: me.id, name: me.name, short: me.short, email: me.email, phone: me.phone }, users: people,
    tenants: all.map(x => ({ slug: x.slug, name: x.name, initials: x.initials })) };
  if (!t) return { ...base, tenant: null };

  const tpl = await db.select().from(templates).where(eq(templates.tenantId, t.id)).orderBy(asc(templates.key));
  const tstats = await db.select({ v: messages.variant, sent: sql<number>`count(${messages.sentAt})::int`, replies: sql<number>`count(${messages.repliedAt})::int`, bounced: sql<number>`count(${messages.bouncedAt})::int` })
    .from(messages).where(eq(messages.tenantId, t.id)).groupBy(messages.variant);

  const drafts = await db.select({ m: messages, l: leads }).from(messages).innerJoin(leads, eq(leads.id, messages.leadId))
    .where(and(eq(messages.tenantId, t.id), inArray(messages.status, ["entwurf", "freigegeben", "uebersprungen"])))
    .orderBy(asc(messages.batchDate), asc(messages.id));

  const mailbox: Record<number, string | null> = {};
  for (const p of people) mailbox[p.id] = await mailboxOf(t.id, p.id);

  return {
    ...base,
    tenant: { slug: t.slug, name: t.name, initials: t.initials, domain: t.domain, tenders: t.tenders, settings: t.settings, invoice: t.invoice },
    templates: tpl.map(x => ({ ...x, ...(tstats.find(s => s.v === x.key) || { sent: 0, replies: 0, bounced: 0 }) })),
    drafts: drafts.map(({ m, l }) => ({
      id: m.id, batchDate: m.batchDate, variant: m.variant, channel: m.channel, subject: m.subject, body: m.body, status: m.status, error: m.error, senderId: m.senderId,
      lead: { id: l.id, company: l.company, city: l.city, first: l.first, last: l.last, salutation: l.salutation, role: l.role, email: l.email, emailType: l.emailType,
        linkedin: l.linkedin, hook: l.hook, tenders: l.tenders, source: l.source, website: l.website },
    })),
    integ: await integStatus(t.id, me.id),
    msConfigured: msConfigured(),
    mailbox,
    runs: await lastRuns(t.id),
  };
});
