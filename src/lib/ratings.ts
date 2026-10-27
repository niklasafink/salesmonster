import { and, eq, sql } from "drizzle-orm";
import { companies, db, leads, messages, tenants, type RatingInfo } from "@/db";
import { after } from "next/server";
import { rateAccount } from "./account-rating";
import { profileCompanies } from "./company-profile";
import { fitLeads } from "./lead-fit";
import { learnModel, rateLead, type Outcome, type RateLead } from "./lead-rating";
import { rubricOf } from "./rubrics";
import { syncTouches } from "./touches";

type Lead = { [K in keyof typeof RATE_COLS]: (typeof leads.$inferSelect)[K] };
const ids = (m: { leadId: number; leadIds: number[] }) => m.leadIds?.length ? m.leadIds : [m.leadId];

/* Learns the tenant's model from every mail that went out and every thumb, then rates all its leads in one statement per 500 */
/* only what rateLead reads, and the stored rating to compare with; the research text alone is most of a lead's weight */
const RATE_COLS = { id: leads.id, status: leads.status, email: leads.email, emailType: leads.emailType, first: leads.first, last: leads.last, salutation: leads.salutation, role: leads.role,
  linkedin: leads.linkedin, hook: leads.hook, tenders: leads.tenders, fit: leads.fit, fitInfo: leads.fitInfo, vote: leads.vote, source: leads.source, angleId: leads.angleId, createdAt: leads.createdAt,
  rating: leads.rating, ratingInfo: leads.ratingInfo, prospect: leads.prospect, crmAt: leads.crmAt, stage: leads.stage, companyId: leads.companyId };
const OFF = ["papierkorb", "dublette"];

/* jsonb gives keys back in its own order, so a plain JSON.stringify would call every stored rating changed and rewrite them all */
const same = (v: unknown): string => v === null || typeof v !== "object" ? JSON.stringify(v) ?? "null"
  : Array.isArray(v) ? `[${v.map(same).join(",")}]` : `{${Object.keys(v).filter(k => (v as Record<string, unknown>)[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${same((v as Record<string, unknown>)[k])}`).join(",")}}`;

export async function rerate(tenantId: number, now = new Date()) {
  /* with a rubric, CRM contacts are rated by what their company is worth; without one they are never written to cold and not rated */
  const [t] = await db.select({ slug: tenants.slug, settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId));
  const rubric = t ? rubricOf(t) : null;
  const [all, ms, cos] = await Promise.all([db.select(RATE_COLS).from(leads).where(and(eq(leads.tenantId, tenantId), rubric ? undefined : eq(leads.prospect, true))),
    db.select({ leadId: messages.leadId, leadIds: messages.leadIds, status: messages.status, sentAt: messages.sentAt, repliedAt: messages.repliedAt, bouncedAt: messages.bouncedAt })
      .from(messages).where(eq(messages.tenantId, tenantId)),
    rubric ? db.select({ id: companies.id, profile: companies.profile }).from(companies).where(eq(companies.tenantId, tenantId)) : []]);
  const profiles = new Map(cos.map(c => [c.id, c.profile]));
  const perCo = new Map<number, number>();
  for (const l of all) if (l.companyId != null && !OFF.includes(l.status)) perCo.set(l.companyId, (perCo.get(l.companyId) || 0) + 1);
  const skips = new Map<number, number>();
  for (const m of ms) if (m.status === "uebersprungen") for (const id of ids(m)) skips.set(id, (skips.get(id) || 0) + 1);
  const byId = new Map(all.map(l => [l.id, l]));
  const view = (l: Lead): RateLead => ({ ...l, skips: skips.get(l.id) || 0 });

  const history: Outcome[] = [];
  for (const m of ms) if (m.sentAt) for (const id of ids(m)) {
    const l = byId.get(id);
    if (l?.prospect) history.push({ lead: { ...view(l), vote: 0 }, delivered: !m.bouncedAt, replied: !!m.repliedAt, bounced: !!m.bouncedAt });
  }
  for (const l of all) if (l.vote && l.prospect) history.push({ lead: view(l), delivered: false, replied: false });
  const model = learnModel(history);

  const rows: [number, number | null, RatingInfo | null][] = [];
  for (const l of all) {
    let rating: number | null, info: RatingInfo | null;
    const colleagues = l.companyId != null ? Math.max(0, (perCo.get(l.companyId) || 0) - (OFF.includes(l.status) ? 0 : 1)) : 0;
    const profile = l.companyId != null ? profiles.get(l.companyId) ?? null : null;
    if (rubric && !l.prospect) {
      /* registered on the website: the company and what the person showed */
      const a = rateAccount(profile, { email: l.email, emailType: l.emailType, role: l.role, stage: l.stage, crmAt: l.crmAt, vote: l.vote, inbound: true, colleagues }, rubric, now);
      rating = OFF.includes(l.status) ? null : a.rating;
      info = rating !== null && a.grade ? { grade: a.grade, expected: 0, parts: a.parts, reasons: a.reasons, type: a.type, why: a.why } : null;
    } else {
      /* found for cold outreach: the company's worth (person fields are judged by reach and role below) times how reachable */
      const a = rubric ? rateAccount(profile, { email: "", emailType: "", role: "", stage: "", crmAt: null, vote: 0, inbound: false, colleagues }, rubric, now) : null;
      if (a && a.rating === null) { rating = null; info = null; }
      else {
        const r = rateLead({ ...view(l), account: a && { score: a.rating!, reasons: a.reasons, why: a.why } }, model, now);
        rating = r.rating;
        info = r.grade ? { grade: r.grade, expected: r.expected, parts: r.parts, reasons: r.reasons, ...(a ? { type: a.type, why: a.why } : {}) } : null;
      }
    }
    if (rating !== l.rating || same(info) !== same(l.ratingInfo)) rows.push([l.id, rating, info]);
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
  const [t] = await db.select({ slug: tenants.slug, settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId));
  const rubric = t ? rubricOf(t) : null;
  if (rubric) {
    const p = await profileCompanies(tenantId, rubric).catch(e => ({ error: (e as Error).message }));
    if (p.error) console.error("profile", tenantId, p.error);
  }
  return rerate(tenantId);
}

/* Runs after the response inside a request; outside one (scripts, tests) it runs right away */
export async function later(fn: () => Promise<unknown>) {
  const run = () => fn().catch(e => console.error("later", (e as Error).message));
  try { after(run); } catch { await run(); }
}

/* Contacts from HubSpot: who we already spoke to (Jev reads the activities), then what their companies are, then all ratings.
   Runs in the hourly cron and after "Jetzt abgleichen"; the list itself only profiles companies that are new. */
export async function refreshAccounts(tenantId: number) {
  const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  const rubric = t ? rubricOf(t) : null;
  if (!rubric) return null;
  const touches = await syncTouches(tenantId).catch(e => ({ contacts: 0, judged: 0, failed: 0, error: (e as Error).message }));
  const profiles = await profileCompanies(tenantId, rubric).catch(e => ({ judged: 0, web: 0, failed: 0, error: (e as Error).message }));
  for (const [k, r] of [["touches", touches], ["profile", profiles]] as const) if (r.error) console.error(k, tenantId, r.error);
  await rerate(tenantId);
  return { touches, profiles };
}

/* Companies the rubric has not judged yet, then all ratings */
export const profilePending = (tenantId: number) => later(async () => {
  const [t] = await db.select({ slug: tenants.slug, settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId));
  const rubric = t ? rubricOf(t) : null;
  if (!rubric) return;
  const r = await profileCompanies(tenantId, rubric);
  if (r.error) console.error("profile", tenantId, r.error);
  if (r.judged || r.web) await rerate(tenantId);
});

/* Leads the AI has not judged yet, or whose data or ideal customer changed, then all ratings */
export const fitPending = (tenantId: number) => later(async () => {
  const r = await fitLeads(tenantId);
  if (r.error) console.error("fit", tenantId, r.error);
  if (r.judged) await rerate(tenantId);
});
