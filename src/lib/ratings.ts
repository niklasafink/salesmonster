import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, leads, messages, tenants, type RatingInfo } from "@/db";
import { JevLimit, guessFit, jevKey } from "./jev";
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

/* Jev's 0–4 match with the ideal customer for leads that have none yet; a rate limit leaves the rest for the next run */
export async function fitLeads(tenantId: number, only?: number[]) {
  const key = await jevKey(tenantId);
  if (!key) return 0;
  const [t] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId));
  if (!t?.settings.prompt.trim()) return 0;
  const open = await db.select().from(leads).where(and(eq(leads.tenantId, tenantId), isNull(leads.fit), inArray(leads.status, ["neu", "freigabe"]),
    only ? inArray(leads.id, only.length ? only : [0]) : isNotNull(leads.id))).limit(200);
  let n = 0;
  for (let i = 0; i < open.length; i += 25) {
    const chunk = open.slice(i, i + 25);
    try {
      const fit = await guessFit(key, t.settings.prompt, chunk, { wait: false });
      const values = sql.join(chunk.map((l, k) => sql`(${l.id}::int, ${fit[k]}::real)`), sql`, `);
      await db.execute(sql`update leads set fit = v.fit from (values ${values}) as v(id, fit) where leads.id = v.id`);
      n += chunk.length;
    } catch (e) {
      /* rate limit or error: the rest keeps fit null and is asked again next time */
      if (!(e instanceof JevLimit)) console.error("fit", tenantId, (e as Error).message);
      break;
    }
  }
  return n;
}

/* After anything that changes what we know about leads: fit for the new ones, then all ratings */
export async function refreshRatings(tenantId: number, newIds?: number[]) {
  await fitLeads(tenantId, newIds).catch(e => console.error("fit", e));
  return rerate(tenantId);
}
