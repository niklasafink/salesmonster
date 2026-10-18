import { HttpError, route, tenantBySlug } from "@/lib/api";
import { guessColumns, jevKey } from "@/lib/jev";
import { columnsOf, fits, splitTable } from "@/lib/lead-columns";

export const maxDuration = 60;

/* Proposed column mapping for a table, for the user to review before import; null for free text */
export const POST = route(async (req, _c, me) => {
  const { t: slug, text } = await req.json();
  const t = await tenantBySlug(slug, me);
  if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "Keine Daten");
  const table = splitTable(text);
  if (!table) return { cols: null };
  const cols = columnsOf(table);
  /* Jev reads header and values; without Jev, or where it is unsure, the header name decides */
  const key = await jevKey(t.id, me.id);
  const ask = cols.map((c, i) => i).filter(i => cols[i].samples.length);
  const g = key && ask.length ? await guessColumns(key, ask.map(i => cols[i])).catch(e => { console.error(e); return []; }) : [];
  /* a guess the values contradict is dropped: the column stays unassigned rather than filling a field with noise */
  ask.forEach((i, k) => { const f = g[k]; if (f != null) cols[i].field = fits(f, cols[i].samples) ? f : ""; });
  cols.forEach(c => { if (!c.samples.length) c.field = ""; });
  return { cols };
});
