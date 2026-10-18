import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db, enrichJobs, type EnrichField, type EnrichItem, type EnrichJobResult } from "@/db";
import { enrichContacts } from "./enrich";
import { later, refreshRatings } from "./ratings";

type Job = typeof enrichJobs.$inferSelect;

/* parallel searches per job, like the portal did before */
const WORKERS = 3;
/* a call stops claiming leads after this, so the lead in hand finishes inside maxDuration (300 s) */
const BUDGET = 180_000;
/* no progress for this long while running: the call carrying it died, the next look at the job restarts it */
const STALE = 6 * 60_000;

/* Hands the job to a fresh function call, so each call stays within its time limit */
export async function kick(id: number, base: string) {
  await fetch(`${base}/api/cron/enrich`, { method: "POST", headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ id }) })
    .catch(e => console.error("enrich kick", id, (e as Error).message));
}

export async function startJob(tenantId: number, userId: number, items: EnrichItem[], fields: EnrichField[], again: boolean, skipped: number, base: string) {
  /* one run per tenant at a time; a new one replaces what is still running */
  await db.update(enrichJobs).set({ status: "gestoppt", updatedAt: new Date() }).where(and(eq(enrichJobs.tenantId, tenantId), eq(enrichJobs.status, "laeuft")));
  const [j] = await db.insert(enrichJobs).values({ tenantId, userId, items, fields, again, skipped }).returning();
  await later(() => work(j.id, base));
  return j;
}

/* Claims leads one by one until none are left or the time budget is used up, then passes the rest on */
export async function work(id: number, base: string) {
  const start = Date.now();
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (Date.now() - start < BUDGET) {
      const [j] = await db.update(enrichJobs).set({ next: sql`${enrichJobs.next} + 1`, updatedAt: new Date() })
        .where(and(eq(enrichJobs.id, id), eq(enrichJobs.status, "laeuft"), sql`${enrichJobs.next} < jsonb_array_length(${enrichJobs.items})`)).returning();
      if (!j) return;
      const item = j.items[j.next - 1];
      let r: EnrichJobResult;
      try {
        const [x] = await enrichContacts(j.tenantId, j.userId, [item.id], j.fields, j.again);
        r = { ...item, found: x?.found ?? {}, missed: x?.missed ?? [], ...(x?.error ? { error: x.error } : {}) };
      } catch (e) {
        /* no AI or a broken key fails every lead alike, so the run ends */
        await db.update(enrichJobs).set({ status: "fehler", error: (e as Error).message.slice(0, 500), updatedAt: new Date() }).where(eq(enrichJobs.id, id));
        return;
      }
      await db.update(enrichJobs).set({ done: sql`${enrichJobs.done} + 1`, results: sql`${enrichJobs.results} || ${JSON.stringify([r])}::jsonb`, updatedAt: new Date() }).where(eq(enrichJobs.id, id));
      /* address, person and company data change the rating */
      if (Object.keys(r.found).length) await refreshRatings(j.tenantId, [item.id]).catch(e => console.error("enrich rating", (e as Error).message));
    }
  }));
  const [j] = await db.select().from(enrichJobs).where(eq(enrichJobs.id, id));
  if (j?.status !== "laeuft") return;
  if (j.next >= j.items.length) await db.update(enrichJobs).set({ status: "fertig", updatedAt: new Date() }).where(and(eq(enrichJobs.id, id), eq(enrichJobs.status, "laeuft")));
  else await kick(id, base);
}

/* The run the user should see for this tenant: one still going, or a finished one not looked at yet */
export async function currentJob(tenantId: number, userId: number, base: string): Promise<Job | null> {
  const [j] = await db.select().from(enrichJobs)
    .where(and(eq(enrichJobs.tenantId, tenantId), eq(enrichJobs.userId, userId), or(eq(enrichJobs.status, "laeuft"), isNull(enrichJobs.seenAt))))
    .orderBy(desc(enrichJobs.id)).limit(1);
  if (!j) return null;
  if (j.status === "laeuft" && Date.now() - j.updatedAt.getTime() > STALE) {
    /* touch first, so several open tabs do not each restart it */
    const [won] = await db.update(enrichJobs).set({ updatedAt: new Date() }).where(and(eq(enrichJobs.id, j.id), eq(enrichJobs.updatedAt, j.updatedAt))).returning({ id: enrichJobs.id });
    if (won) await later(() => kick(j.id, base));
  }
  return j;
}

export const stopJob = (tenantId: number, id: number) =>
  db.update(enrichJobs).set({ status: "gestoppt", updatedAt: new Date() }).where(and(eq(enrichJobs.id, id), eq(enrichJobs.tenantId, tenantId), eq(enrichJobs.status, "laeuft")));

export const seenJob = (tenantId: number, id: number) =>
  db.update(enrichJobs).set({ seenAt: new Date() }).where(and(eq(enrichJobs.id, id), eq(enrichJobs.tenantId, tenantId)));
