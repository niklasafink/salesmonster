import { and, eq, inArray } from "drizzle-orm";
import { db, enrichJobs, leads, type EnrichField } from "@/db";
import { HttpError, body, route, tenantBySlug } from "@/lib/api";
import { aiFor, AiMissing } from "@/lib/ai";
import { ENRICH_FIELDS } from "@/lib/enrich";
import { currentJob, seenJob, startJob, stopJob } from "@/lib/enrich-jobs";
import { origin } from "@/lib/oauth";

/* the first part of a run is worked off right after the start */
export const maxDuration = 300;

const view = (j: typeof enrichJobs.$inferSelect | null) => j && {
  id: j.id, status: j.status, error: j.error, total: j.items.length, done: j.done, skipped: j.skipped,
  found: j.results.filter(r => Object.keys(r.found).length).length, results: j.results,
};

export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(new URL(req.url).searchParams.get("t"), me);
  return { job: view(await currentJob(t.id, me.id, origin(req))) };
});

export const POST = route(async (req, _c, me) => {
  const b = await body(req);
  const t = await tenantBySlug(typeof b.t === "string" ? b.t : null, me);
  const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is number => Number.isSafeInteger(x)).slice(0, 5000) : [];
  const fields = Array.isArray(b.fields) ? ENRICH_FIELDS.filter(f => (b.fields as unknown[]).includes(f)) as EnrichField[] : [];
  if (!ids.length) throw new HttpError(400, "Keine Leads");
  if (!fields.length) throw new HttpError(400, "Keine Felder gewählt");
  if (!await aiFor(t.id, me.id)) throw new AiMissing();
  const rows = await db.select({ id: leads.id, company: leads.company, salutation: leads.salutation, first: leads.first, last: leads.last })
    .from(leads).where(and(eq(leads.tenantId, t.id), inArray(leads.id, ids)));
  const byId = new Map(rows.map(r => [r.id, r]));
  /* in the order the list showed them */
  const items = ids.flatMap(id => { const r = byId.get(id); if (!r) return [];
    const person = r.last ? [r.salutation, r.first, r.last].filter(Boolean).join(" ") : r.first;
    return [{ id, name: [person, r.company].filter(Boolean).join(", ") }]; });
  const skipped = Number.isSafeInteger(b.skipped) ? Math.max(0, b.skipped as number) : 0;
  return { job: view(await startJob(t.id, me.id, items, fields, b.again === true, skipped, origin(req))) };
});

export const PATCH = route(async (req, _c, me) => {
  const b = await body(req);
  const t = await tenantBySlug(typeof b.t === "string" ? b.t : null, me);
  if (!Number.isSafeInteger(b.id)) throw new HttpError(400, "Lauf fehlt");
  if (b.action === "stop") await stopJob(t.id, b.id as number);
  else if (b.action === "seen") await seenJob(t.id, b.id as number);
  else throw new HttpError(400, "Ungültige Anfrage");
  return { ok: true };
});
