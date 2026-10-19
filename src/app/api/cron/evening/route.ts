import { db, tenants } from "@/db";
import { cronAuthorized } from "@/lib/api";
import { rankFirst } from "@/lib/lead-chat";
import { approvalMail, runResearch } from "@/lib/outreach";
import { addDaysIso, berlinDate } from "@/lib/dates";
import { isSendDay, planOf } from "@/lib/schedule";

export const maxDuration = 300;

/* 20:00 Berlin, every evening before one of the tenant's send days: research tomorrow's batch, then send the approval reminder */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new Response("Unauthorized", { status: 401 });
  const all = await db.select().from(tenants);
  const tomorrow = addDaysIso(berlinDate(), 1);
  const out = await Promise.allSettled(all.filter(t => isSendDay(planOf(t.settings), tomorrow)).map(async t => {
    await rankFirst(t);
    const r = await runResearch(t);
    await approvalMail(t).catch(e => console.error("approval mail", t.slug, e.message));
    return { t: t.slug, ...r };
  }));
  return Response.json(out.map(o => o.status === "fulfilled" ? o.value : { error: String(o.reason?.message || o.reason) }));
}
