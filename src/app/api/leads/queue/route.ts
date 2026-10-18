import { HttpError, body, route, tenantBySlug } from "@/lib/api";
import { setQueue } from "@/lib/queue";

/* { t, ids }: the send queue from the top in this order, as dragged in the lead list */
export const PUT = route(async (req, _c, me) => {
  const b = await body(req);
  const t = await tenantBySlug(String(b.t ?? ""), me);
  if (!Array.isArray(b.ids) || b.ids.length > 2000 || !b.ids.every(x => Number.isSafeInteger(x))) throw new HttpError(400, "Ungültige Reihenfolge");
  await setQueue(t.id, b.ids as number[]);
});
