import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { db, leads, members, messages, templates, users, type MailScore } from "@/db";
import { fill } from "./fill";
import { JevLimit, jevKey, scoreMail } from "./jev";
import { calibrate, draftScore, expectedRate, templateText } from "./draft-score";

type Msg = typeof messages.$inferSelect;
type Lead = typeof leads.$inferSelect;
export type Text = { subject: string; body: string };

export const textHash = (m: Text) => createHash("sha1").update(`${m.subject}\n${m.body}`).digest("hex").slice(0, 12);
const ids = (m: Pick<Msg, "leadId" | "leadIds">) => m.leadIds?.length ? m.leadIds : [m.leadId];

/* The mail as the review screen shows it: the edited text, or the template filled for the covered people */
export async function draftText(m: Msg): Promise<Text & { lead: Lead }> {
  const covered = await db.select().from(leads).where(inArray(leads.id, ids(m))).orderBy(asc(leads.id));
  const lead = covered.find(l => l.id === m.leadId) || covered[0];
  if (m.subject !== null && m.body !== null) return { subject: m.subject, body: m.body, lead };
  const [tpl] = await db.select().from(templates).where(and(eq(templates.tenantId, m.tenantId), eq(templates.key, m.variant)));
  const [me] = m.senderId ? await db.select({ name: users.name }).from(users).where(eq(users.id, m.senderId))
    : await db.select({ name: users.name }).from(users).innerJoin(members, eq(members.userId, users.id)).where(eq(members.tenantId, m.tenantId)).orderBy(asc(users.id)).limit(1);
  if (!tpl) return { subject: m.subject || "", body: m.body || "", lead };
  const l = { ...lead, people: covered.length > 1 ? covered : undefined };
  return { subject: m.subject ?? fill(tpl.subject, l, tpl, me?.name || ""), body: m.body ?? fill(tpl.body, l, tpl, me?.name || ""), lead };
}

/* Expected reply rate per score band from this tenant's sent mails that had time to get an answer (7 days) */
export async function calibration(tenantId: number) {
  const rows = await db.select({ score: messages.score, repliedAt: messages.repliedAt }).from(messages)
    .where(and(eq(messages.tenantId, tenantId), isNotNull(messages.sentAt), sql`${messages.bouncedAt} is null`, sql`${messages.score} ? 'total'`,
      or(isNotNull(messages.repliedAt), lt(messages.sentAt, new Date(Date.now() - 7 * 864e5)))));
  return calibrate(rows.map(r => ({ score: r.score!.total!, replied: !!r.repliedAt })));
}

const hasHook = (l: Lead) => !!l.hook || l.tenders.length > 0;

/* Jev's judgement plus the rules, for one text. Reuses the stored score while the text is unchanged. */
export async function judge(key: string, text: Text, lead: Lead, old: MailScore | null, cal: Awaited<ReturnType<typeof calibration>>, wait = true): Promise<MailScore> {
  const hash = textHash(text);
  const j = old?.hash === hash ? old : await scoreMail(key, { ...text, company: lead.company, role: lead.role }, { wait });
  const { score: total, issues, expected } = draftScore(j, { ...text, hook: hasHook(lead) }, cal);
  const { expected: _old, ...rest } = j;
  return { ...rest, total, issues, ...(expected !== undefined ? { expected } : {}), hash };
}

/* Scores drafts that have none or whose text changed; stops quietly at Jev's rate limit */
export async function scoreDrafts(tenantId: number, msgIds: number[]) {
  const key = await jevKey(tenantId);
  if (!key || !msgIds.length) return 0;
  const cal = await calibration(tenantId);
  const rows = await db.select().from(messages).where(and(eq(messages.tenantId, tenantId), inArray(messages.id, msgIds)));
  let n = 0;
  for (const m of rows) {
    try {
      const t = await draftText(m);
      const score = await judge(key, t, t.lead, m.score, cal, false);
      if (score.hash !== m.score?.hash || score.total !== m.score?.total) { await db.update(messages).set({ score }).where(eq(messages.id, m.id)); n++; }
    } catch (e) { if (e instanceof JevLimit) break; console.error("score", m.id, (e as Error).message); }
  }
  return n;
}

export type TplStat = { sent: number; replies: number; bounced: number; total: number | null; expected: number; prior: number; improved: { sent: number; replies: number } };

/* Per template: real sends and replies, Jev's score of the template text, and the expected reply rate.
   The prior is the calibrated rate for that score, else the tenant's own rate (4 % until there are sends). */
export async function templateStats(tenantId: number): Promise<Record<string, TplStat>> {
  const [tpls, rows, cal] = await Promise.all([
    db.select().from(templates).where(eq(templates.tenantId, tenantId)),
    db.select({ v: messages.variant, sent: sql<number>`count(${messages.sentAt}) - count(${messages.bouncedAt})`.mapWith(Number),
      replies: sql<number>`count(${messages.repliedAt})`.mapWith(Number), bounced: sql<number>`count(${messages.bouncedAt})`.mapWith(Number) })
      .from(messages).where(eq(messages.tenantId, tenantId)).groupBy(messages.variant),
    calibration(tenantId),
  ]);
  const imp = await db.select({ v: messages.variant, sent: sql<number>`count(${messages.sentAt}) - count(${messages.bouncedAt})`.mapWith(Number), replies: sql<number>`count(${messages.repliedAt})`.mapWith(Number) })
    .from(messages).where(and(eq(messages.tenantId, tenantId), eq(messages.improved, true))).groupBy(messages.variant);
  const N = rows.reduce((a, r) => a + r.sent, 0), R = rows.reduce((a, r) => a + r.replies, 0);
  const base = (R + 30 * 0.04) / (N + 30);
  return Object.fromEntries(tpls.map(t => {
    const r = rows.find(x => x.v === t.key) || { sent: 0, replies: 0, bounced: 0 };
    const total = t.score ? draftScore(t.score, templateText(t)).score : null;
    const prior = cal && total !== null ? cal(total) : base;
    return [t.key, { sent: r.sent, replies: r.replies, bounced: r.bounced, total, prior, expected: expectedRate(r.sent, r.replies, prior),
      improved: imp.find(x => x.v === t.key) || { sent: 0, replies: 0 } }];
  }));
}
