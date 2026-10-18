import { and, eq, lt } from "drizzle-orm";
import { db, invoices, tenants } from "@/db";
import { cronAuthorized } from "@/lib/api";
import { berlinDate } from "@/lib/dates";
import { checkReplies, sendApproved } from "@/lib/outreach";
import { syncAll } from "@/lib/mail-sync";

export const maxDuration = 300;

/* 08:00 Berlin, daily: count replies, send what is due in the send window, flag overdue invoices */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new Response("Unauthorized", { status: 401 });
  const t0 = Date.now();
  const all = await db.select().from(tenants);
  const out = await Promise.allSettled(all.map(async t => {
    const replies = await checkReplies(t);
    const r = await sendApproved(t);
    return { t: t.slug, replies, ...r };
  }));
  /* new mail since yesterday into the contacts, in the time that is left */
  await syncAll(Math.max(0, 270_000 - (Date.now() - t0))).catch(e => console.error(e));
  await db.update(invoices).set({ status: "überfällig" }).where(and(eq(invoices.status, "offen"), lt(invoices.dueDate, berlinDate())));
  return Response.json(out.map(o => o.status === "fulfilled" ? o.value : { error: String(o.reason?.message || o.reason) }));
}
