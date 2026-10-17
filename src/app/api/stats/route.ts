import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, messages } from "@/db";
import { qp, route, tenantBySlug } from "@/lib/api";

/* Daily rows per sender; the client buckets them by period */
export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  const day = sql<string>`to_char(${messages.sentAt} at time zone 'Europe/Berlin', 'YYYY-MM-DD')`;
  const rows = await db.select({
    d: day, sender: messages.senderId,
    sent: sql<number>`count(*)::int`, rep: sql<number>`count(${messages.repliedAt})::int`,
    bounce: sql<number>`count(${messages.bouncedAt})::int`, hub: sql<number>`sum(case when ${messages.hubspot} then 1 else 0 end)::int`,
  }).from(messages).where(and(eq(messages.tenantId, t.id), isNotNull(messages.sentAt))).groupBy(day, messages.senderId).orderBy(day);
  return { rows };
});
