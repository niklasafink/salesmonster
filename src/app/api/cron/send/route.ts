import { db, tenants } from "@/db";
import { cronAuthorized } from "@/lib/api";
import { sendApproved } from "@/lib/outreach";
import { syncCrm } from "@/lib/crm-sync";
import { refreshAccounts } from "@/lib/ratings";

export const maxDuration = 300;

/* Every hour (Vercel once per hour of the day, GitHub Actions on top): each tenant sends its share inside its own send window */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new Response("Unauthorized", { status: 401 });
  const all = await db.select().from(tenants);
  const out = await Promise.allSettled(all.map(async t => ({ t: t.slug, ...await sendApproved(t) })));
  /* then the registered users from HubSpot, once an hour like the sending */
  const crm = await Promise.allSettled(all.map(async t => {
    const s = await syncCrm(t, 60_000);
    /* then who we spoke to and what the companies are, for the rating */
    const a = await refreshAccounts(t.id).catch(e => ({ error: (e as Error).message }));
    return (s || a) && { t: t.slug, crm: s?.status, error: s?.error || undefined, accounts: a || undefined };
  }));
  return Response.json([...out.map(o => o.status === "fulfilled" ? o.value : { error: String(o.reason?.message || o.reason) }),
    ...crm.flatMap((o): unknown[] => o.status === "fulfilled" ? (o.value ? [o.value] : []) : [{ error: String(o.reason?.message || o.reason) }])]);
}
