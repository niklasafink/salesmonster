import { HttpError, body, route, tenantBySlug } from "@/lib/api";
import { ENRICH_FIELDS, enrichContacts } from "@/lib/enrich";
import { later, refreshRatings } from "@/lib/ratings";
import type { EnrichField } from "@/db";

/* one web search per lead, a few leads per request */
export const maxDuration = 300;

export const POST = route(async (req, _c, me) => {
  const b = await body(req);
  const t = await tenantBySlug(typeof b.t === "string" ? b.t : null, me);
  const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is number => Number.isSafeInteger(x)) : [];
  const fields = Array.isArray(b.fields) ? ENRICH_FIELDS.filter(f => (b.fields as unknown[]).includes(f)) as EnrichField[] : [];
  if (!ids.length) throw new HttpError(400, "Keine Leads");
  if (!fields.length) throw new HttpError(400, "Keine Felder gewählt");
  const results = await enrichContacts(t.id, me.id, ids, fields, b.again === true);
  /* address, person and company data change the rating */
  const changed = results.filter(r => Object.keys(r.found).length).map(r => r.id);
  if (changed.length) await later(() => refreshRatings(t.id, changed));
  return { results };
});
