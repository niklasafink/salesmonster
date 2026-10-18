import { inArray } from "drizzle-orm";
import { db, members, tenants, users } from "@/db";
import { COOKIE, signSession } from "@/lib/session";
import { reqStore } from "./req";

/* Throwaway users/tenants on the test branch; cleanup() deletes them (leads etc. go by cascade) */
export function fixtures() {
  const uids: number[] = [], tids: number[] = [];
  const tag = () => `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    async user() {
      const t = tag();
      const [u] = await db.insert(users).values({ email: `${t}@example.test`, name: "Test Nutzer", short: "TN", passwordHash: "-" }).returning();
      uids.push(u.id);
      return u;
    },
    async tenant(owner: { id: number }) {
      const t = tag();
      const [row] = await db.insert(tenants).values({ slug: t, name: `Test ${t}`, initials: "TT", domain: "example.test",
        settings: { prompt: "", leadsPerDay: 10, cooldownDays: 30 } }).returning();
      tids.push(row.id);
      await db.insert(members).values({ tenantId: row.id, userId: owner.id });
      return row;
    },
    async cleanup() {
      if (tids.length) await db.delete(tenants).where(inArray(tenants.id, tids.splice(0)));
      if (uids.length) await db.delete(users).where(inArray(users.id, uids.splice(0)));
    },
  };
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/* Calls a route handler like Next would: a Request carrying the session cookie of `as` */
export async function call<C = unknown>(handler: Handler<C>, opts: { as?: { id: number }; method?: string; path?: string; body?: unknown; ctx?: C } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.as) headers.set("cookie", `${COOKIE}=${await signSession(opts.as.id)}`);
  const req = new Request(`http://localhost${opts.path || "/"}`, { method: opts.method || (opts.body ? "POST" : "GET"), headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  const res = await reqStore.run(req, () => handler(req, opts.ctx as C));
  return { status: res.status, json: await res.json() };
}
