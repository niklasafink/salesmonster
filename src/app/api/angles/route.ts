import { angles, db } from "@/db";
import { HttpError, body, qp, route, tenantBySlug } from "@/lib/api";
import { angleStats, ensureAngles } from "@/lib/strategy";

const view = (a: Awaited<ReturnType<typeof angleStats>>[number]) => ({ id: a.id, label: a.label, query: a.query, origin: a.origin, active: a.active, rounds: a.rounds, leads: a.leads, sent: a.sent, replies: a.replies, score: a.score });

export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  await ensureAngles(t);
  return { rows: (await angleStats(t.id)).map(view) };
});

/* The user's own direction; the AI never pauses it */
export const POST = route(async (req, _c, me) => {
  const b = await body(req);
  const t = await tenantBySlug(typeof b.t === "string" ? b.t : null, me);
  const label = typeof b.label === "string" ? b.label.trim().slice(0, 80) : "";
  if (!label) throw new HttpError(400, "Name fehlt");
  const query = typeof b.query === "string" ? b.query.trim().slice(0, 400) : "";
  const [a] = await db.insert(angles).values({ tenantId: t.id, label, query: query || label, origin: "nutzer" }).returning();
  return { id: a.id };
});
