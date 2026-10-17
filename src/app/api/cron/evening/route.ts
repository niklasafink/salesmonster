import { db, tenants } from "@/db";
import { cronAuthorized } from "@/lib/api";
import { approvalMail, runResearch } from "@/lib/outreach";

export const maxDuration = 300;

/* 20:00 Berlin, Sun–Thu: research tomorrow's batch, then send the approval reminder */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new Response("Unauthorized", { status: 401 });
  const all = await db.select().from(tenants);
  const out = await Promise.allSettled(all.map(async t => {
    const r = await runResearch(t);
    await approvalMail(t).catch(e => console.error("approval mail", t.slug, e.message));
    return { t: t.slug, ...r };
  }));
  return Response.json(out.map(o => o.status === "fulfilled" ? o.value : { error: String(o.reason?.message || o.reason) }));
}
