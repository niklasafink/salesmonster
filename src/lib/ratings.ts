import { eq, sql } from "drizzle-orm";
import { db, leads, messages, type RatingInfo } from "@/db";
import { after } from "next/server";
import { fitLeads } from "./lead-fit";
import { learnModel, rateLead, type Outcome, type RateLead } from "./lead-rating";

type Lead = typeof leads.$inferSelect;
const ids = (m: { leadId: number; leadIds: number[] }) => m.leadIds?.length ? m.leadIds : [m.leadId];

/* Learns the tenant's model from every mail that went out and every thumb, then rates all its leads in one statement per 500 */
export async function rerate(tenantId: number, now = new Date()) {
  const all = await db.select().from(leads).where(eq(leads.tenantId, tenantId));
  const ms = await db.select({ leadId: messages.leadId, leadIds: messages.leadIds, status: messages.status, sentAt: messages.sentAt, repliedAt: messages.repliedAt, bouncedAt: messages.bouncedAt })
    .from(messages).where(eq(messages.tenantId, tenantId));
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
    if (r.rating !== l.rating || JSON.stringify(info) !== JSON.stringify(l.ratingInfo)) rows.push([l.id, r.rating, info]);
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
