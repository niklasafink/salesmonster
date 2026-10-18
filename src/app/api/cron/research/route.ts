import { db, tenants } from "@/db";
import { cronAuthorized } from "@/lib/api";
import { researchLoop } from "@/lib/strategy";

export const maxDuration = 300;

/* Hourly from GitHub Actions: research rounds through the day for tenants that set rounds per day */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new Response("Unauthorized", { status: 401 });
  const all = await db.select().from(tenants);
  const out = await Promise.allSettled(all.filter(t => (t.settings.roundsPerDay ?? 0) > 0).map(async t => ({ t: t.slug, ...await researchLoop(t) })));
  return Response.json(out.map(o => o.status === "fulfilled" ? o.value : { error: String(o.reason?.message || o.reason) }));
}
