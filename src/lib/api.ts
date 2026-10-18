import { cookies } from "next/headers";
import { and, eq, ne, sql } from "drizzle-orm";
import { db, leads, members, tenants, users } from "@/db";
import { AiMissing } from "./ai";
import { validEmail } from "./lead-fields";
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

/* Address checks for a hand-entered contact: well formed, not already in this tenant (other than the lead itself) */
export async function checkEmail(tenantId: number, email: string | undefined, self?: number) {
  if (!email) return;
  if (!validEmail(email)) throw new HttpError(400, "E-Mail ungültig");
  const [d] = await db.select({ id: leads.id }).from(leads)
    .where(and(eq(leads.tenantId, tenantId), sql`lower(${leads.email}) = ${email.toLowerCase()}`, self ? ne(leads.id, self) : undefined)).limit(1);
  if (d) throw new HttpError(400, "Schon in der Liste");
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

/* Request body as an object; malformed JSON or a non-object body is the caller's fault */
export async function body(req: Request): Promise<Record<string, unknown>> {
  const b = await req.json().catch(() => { throw new HttpError(400, "Ungültige Anfrage"); });
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "Ungültige Anfrage");
  return b;
}

/* Numeric id from a path or query; anything else cannot exist */
export function numId(raw: string | null | undefined, what = "Eintrag") {
  const id = Number(raw);
  if (!raw || !Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw new HttpError(404, `${what} nicht gefunden`);
  return id;
}
export const idOf = async (params: Promise<{ id: string }>, what = "Eintrag") => numId((await params).id, what);

/* What a caller (portal or MCP client) gets to see of an error; everything unexpected is logged */
export function publicError(e: unknown): { status: number; message: string } {
  if (e instanceof HttpError) return { status: e.status, message: e.message };
  if (e instanceof SyntaxError) return { status: 400, message: "Ungültige Anfrage" };
  if (e instanceof AiMissing) return { status: 400, message: e.message };
  console.error(e);
  /* Our own messages are meant for the user; runtime and database errors would leak SQL and parameters */
  const own = e instanceof Error && e.constructor === Error && !e.cause && !/^Failed query/.test(e.message);
  return { status: 500, message: own ? (e as Error).message : "Interner Fehler" };
}

export function fail(e: unknown) {
  const { status, message } = publicError(e);
  return Response.json({ error: message }, { status });
}

export const qp = (req: Request, k: string) => new URL(req.url).searchParams.get(k);

export function cronAuthorized(req: Request) {
  return req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
}
