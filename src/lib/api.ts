import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { db, members, tenants, users } from "@/db";
import { COOKIE, readSession } from "./session";

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function currentUser() {
  const uid = await readSession((await cookies()).get(COOKIE)?.value);
  if (!uid) throw new HttpError(401, "Nicht angemeldet");
  const [u] = await db.select().from(users).where(eq(users.id, uid));
  if (!u) throw new HttpError(401, "Nicht angemeldet");
  return u;
}

/* Tenants of other people answer like missing ones */
export async function tenantBySlug(slug: string | null, user: { id: number }) {
  if (!slug) throw new HttpError(400, "Mandant fehlt");
  const [row] = await db.select({ t: tenants }).from(tenants).innerJoin(members, and(eq(members.tenantId, tenants.id), eq(members.userId, user.id)))
    .where(eq(tenants.slug, slug));
  if (!row) throw new HttpError(404, "Mandant nicht gefunden");
  return row.t;
}

export async function assertMember(user: { id: number }, tenantId: number, what = "Eintrag") {
  const [m] = await db.select({ id: members.id }).from(members).where(and(eq(members.tenantId, tenantId), eq(members.userId, user.id)));
  if (!m) throw new HttpError(404, `${what} nicht gefunden`);
}

export async function tenantMembers(tenantId: number) {
  return db.select({ id: users.id, name: users.name, short: users.short, email: users.email, phone: users.phone })
    .from(users).innerJoin(members, eq(members.userId, users.id)).where(eq(members.tenantId, tenantId)).orderBy(users.id);
}

/* Wraps a route handler: auth, JSON errors */
export function route<C = unknown>(fn: (req: Request, ctx: C, user: Awaited<ReturnType<typeof currentUser>>) => Promise<unknown>) {
  return async (req: Request, ctx: C) => {
    try {
      const user = await currentUser();
      const out = await fn(req, ctx, user);
      return out instanceof Response ? out : Response.json(out ?? { ok: true });
    } catch (e) {
      return fail(e);
    }
  };
}

export function fail(e: unknown) {
  if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
  console.error(e);
  return Response.json({ error: e instanceof Error ? e.message : "Fehler" }, { status: 500 });
}

export const qp = (req: Request, k: string) => new URL(req.url).searchParams.get(k);

export function cronAuthorized(req: Request) {
  return req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
}
