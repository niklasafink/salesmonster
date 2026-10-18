import { sql } from "drizzle-orm";
import { db } from "@/db";
import { qp, route, tenantBySlug } from "@/lib/api";

/* AI cost of a tenant: one sum per Berlin day for the chart, one row per action for the list (an enrich job's calls are one action) */
export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  const [days, actions] = await Promise.all([
    db.execute<{ d: string; cost: string }>(sql`
      select to_char(created_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as d, sum(cost_micro)::bigint as cost
        from ai_usage where tenant_id = ${t.id} group by 1 order by 1`),
    db.execute<{ kind: string; at: Date | string; items: number; calls: number; unpriced: number; cost: string }>(sql`
      select kind, max(created_at) as at, sum(items)::int as items, sum(calls)::int as calls, sum(unpriced)::int as unpriced, sum(cost_micro)::bigint as cost
        from ai_usage where tenant_id = ${t.id}
       group by kind, coalesce(ref, id::text)
       order by at desc limit 1000`),
  ]);
  return {
    days: days.rows.map(r => ({ d: r.d, cost: Number(r.cost) })),
    actions: actions.rows.map(r => ({ kind: r.kind, at: new Date(r.at).toISOString(), items: r.items, calls: r.calls, unpriced: r.unpriced, cost: Number(r.cost) })),
  };
});
