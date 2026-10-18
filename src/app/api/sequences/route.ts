import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, enrollments, sequenceMails, sequenceTemplates, sequences } from "@/db";
import { qp, route, tenantBySlug } from "@/lib/api";
import { createSequence, stepStats } from "@/lib/sequences";

/* The tenant's sequences with variants, numbers per step, people waiting for a decision and the latest people */
export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  const list = await db.select().from(sequences).where(eq(sequences.tenantId, t.id)).orderBy(asc(sequences.id));
  return { sequences: await Promise.all(list.map(async s => {
    const tpls = await db.select().from(sequenceTemplates).where(eq(sequenceTemplates.sequenceId, s.id)).orderBy(asc(sequenceTemplates.step), asc(sequenceTemplates.key));
    const stats = await stepStats(s.id);
    const people = await db.select().from(enrollments).where(eq(enrollments.sequenceId, s.id)).orderBy(desc(enrollments.startedAt)).limit(300);
    const waiting = await db.select().from(enrollments).where(and(eq(enrollments.sequenceId, s.id), inArray(enrollments.status, ["antwort"]))).orderBy(desc(enrollments.repliedAt));
    const counts = await db.select({ status: enrollments.status, n: sql<number>`count(*)::int` }).from(enrollments).where(eq(enrollments.sequenceId, s.id)).groupBy(enrollments.status);
    /* Every enrollment with the steps it was sent and replied to, for the funnel by registration date */
    const all = await db.select({ id: enrollments.id, at: enrollments.startedAt, status: enrollments.status }).from(enrollments).where(eq(enrollments.sequenceId, s.id));
    const mails = await db.select({ e: sequenceMails.enrollmentId, step: sequenceMails.step, replied: sequenceMails.repliedAt, bounced: sequenceMails.bouncedAt }).from(sequenceMails).where(eq(sequenceMails.sequenceId, s.id));
    const flow = all.map(e => { const m = mails.filter(x => x.e === e.id);
      return { at: e.at, status: e.status, sent: m.filter(x => !x.bounced).map(x => x.step), replied: m.filter(x => x.replied).map(x => x.step) }; });
    const shape = (e: typeof people[number]) => ({ id: e.id, email: e.email, first: e.first, last: e.last, company: e.company, salutation: e.salutation, startedAt: e.startedAt, step: e.step, status: e.status, lastSentAt: e.lastSentAt, repliedAt: e.repliedAt });
    return { id: s.id, name: s.name, active: s.active, steps: s.steps, config: s.config,
      templates: tpls.map(x => ({ id: x.id, step: x.step, key: x.key, tone: x.tone, subject: x.subject, body: x.body, active: x.active, score: x.score, ...stats(x.step, x.key) })),
      people: people.map(shape), waiting: waiting.map(shape), counts: Object.fromEntries(counts.map(c => [c.status, c.n])), flow };
  })) };
});

export const POST = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  const s = await createSequence(t, me.id);
  return { id: s.id };
});
