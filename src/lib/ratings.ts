import { and, eq, sql } from "drizzle-orm";
import { db, leads, messages, type RatingInfo } from "@/db";
import { after } from "next/server";
import { fitLeads } from "./lead-fit";
import { learnModel, rateLead, type Outcome, type RateLead } from "./lead-rating";

type Lead = { [K in keyof typeof RATE_COLS]: (typeof leads.$inferSelect)[K] };
const ids = (m: { leadId: number; leadIds: number[] }) => m.leadIds?.length ? m.leadIds : [m.leadId];

/* Learns the tenant's model from every mail that went out and every thumb, then rates all its leads in one statement per 500 */
/* only what rateLead reads, and the stored rating to compare with; the research text alone is most of a lead's weight */
const RATE_COLS = { id: leads.id, status: leads.status, email: leads.email, emailType: leads.emailType, first: leads.first, last: leads.last, salutation: leads.salutation, role: leads.role,
  linkedin: leads.linkedin, hook: leads.hook, tenders: leads.tenders, fit: leads.fit, fitInfo: leads.fitInfo, vote: leads.vote, source: leads.source, angleId: leads.angleId, createdAt: leads.createdAt,
  rating: leads.rating, ratingInfo: leads.ratingInfo };

/* jsonb gives keys back in its own order, so a plain JSON.stringify would call every stored rating changed and rewrite them all */
const same = (v: unknown): string => v === null || typeof v !== "object" ? JSON.stringify(v) ?? "null"
  : Array.isArray(v) ? `[${v.map(same).join(",")}]` : `{${Object.keys(v).filter(k => (v as Record<string, unknown>)[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${same((v as Record<string, unknown>)[k])}`).join(",")}}`;

export async function rerate(tenantId: number, now = new Date()) {
  /* CRM contacts are never written to cold, so they are not rated */
  const [all, ms] = await Promise.all([db.select(RATE_COLS).from(leads).where(and(eq(leads.tenantId, tenantId), eq(leads.prospect, true))),
    db.select({ leadId: messages.leadId, leadIds: messages.leadIds, status: messages.status, sentAt: messages.sentAt, repliedAt: messages.repliedAt, bouncedAt: messages.bouncedAt })
      .from(messages).where(eq(messages.tenantId, tenantId))]);
  const skips = new Map<number, number>();
  for (const m of ms) if (m.status === "uebersprungen") for (const id of ids(m)) skips.set(id, (skips.get(id) || 0) + 1);
  const byId = new Map(all.map(l => [l.id, l]));
  const view = (l: Lead): RateLead => ({ ...l, skips: skips.get(l.id) || 0 });

  const history: Outcome[] = [];
  for (const m of ms) if (m.sentAt) for (const id of ids(m)) {
    const l = byId.get(id);
    if (l) history.push({ lead: { ...view(l), vote: 0 }, delivered: !m.bouncedAt, replied: !!m.repliedAt, bounced: !!m.bouncedAt });
  }
  for (const l of all) if (l.vote) history.push({ lead: view(l), delivered: false, replied: false });
  const model = learnModel(history);

  const rows: [number, number | null, RatingInfo | null][] = [];
  for (const l of all) {
    const r = rateLead(view(l), model, now);
    const info: RatingInfo | null = r.grade ? { grade: r.grade, expected: r.expected, parts: r.parts, reasons: r.reasons } : null;
    if (r.rating !== l.rating || same(info) !== same(l.ratingInfo)) rows.push([l.id, r.rating, info]);
  }
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const values = sql.join(chunk.map(([id, rating, info]) => sql`(${id}::int, ${rating}::int, ${info ? JSON.stringify(info) : null}::jsonb)`), sql`, `);
    await db.execute(sql`update leads set rating = v.rating, rating_info = v.info from (values ${values}) as v(id, rating, info) where leads.id = v.id`);
  }
  return rows.length;
}

/* After anything that changes what we know about leads: fit for the new ones, then all ratings */
export async function refreshRatings(tenantId: number, newIds?: number[]) {
  const r = await fitLeads(tenantId, newIds).catch(e => ({ judged: 0, failed: 0, error: (e as Error).message }));
  if (r.error) console.error("fit", tenantId, r.error);
  return rerate(tenantId);
}

/* Runs after the response inside a request; outside one (scripts, tests) it runs right away */
export async function later(fn: () => Promise<unknown>) {
  const run = () => fn().catch(e => console.error("later", (e as Error).message));
  try { after(run); } catch { await run(); }
}

/* Leads the AI has not judged yet, or whose data or ideal customer changed, then all ratings */
export const fitPending = (tenantId: number) => later(async () => {
  const r = await fitLeads(tenantId);
  if (r.error) console.error("fit", tenantId, r.error);
  if (r.judged) await rerate(tenantId);
});
