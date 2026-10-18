import { db, tenants } from "@/db";
import { cronAuthorized } from "@/lib/api";
import { runSequences } from "@/lib/sequences";

export const maxDuration = 300;

/* Hourly (GitHub Actions) and once a day from Vercel as a fallback */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new Response("Unauthorized", { status: 401 });
  const all = await db.select().from(tenants);
  const out = await Promise.allSettled(all.map(async t => ({ t: t.slug, runs: await runSequences(t) })));
  return Response.json(out.map(o => o.status === "fulfilled" ? o.value : { error: String(o.reason?.message || o.reason) }));
}
