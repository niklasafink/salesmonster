import { and, asc, eq, isNull } from "drizzle-orm";
import { db, integrations, members } from "@/db";
import { decrypt, encrypt } from "./crypto";
import { INTEG, type IntegKind } from "./integ-meta";

const meta = (k: IntegKind) => INTEG.find(i => i.k === k);
const perUser = (k: IntegKind) => !!meta(k)?.perUser;
const account = (k: IntegKind) => !!meta(k)?.account;

/* Account keys are never shared: a user gets only their own; cron jobs (no user) use the tenant owner's, the first member */
async function accountRow(tenantId: number, kind: IntegKind, userId?: number | null) {
  const [owner] = userId ? [{ userId }] : await db.select({ userId: members.userId }).from(members)
    .where(eq(members.tenantId, tenantId)).orderBy(asc(members.id)).limit(1);
  if (!owner) return undefined;
  const [row] = await db.select({ config: integrations.config }).from(integrations)
    .innerJoin(members, and(eq(members.userId, integrations.userId), eq(members.tenantId, tenantId)))
    .where(and(isNull(integrations.tenantId), eq(integrations.kind, kind), eq(integrations.userId, owner.userId)));
  return row;
}

export async function getInteg<T = Record<string, string>>(tenantId: number, kind: IntegKind, userId?: number | null): Promise<T | null> {
  const [row] = account(kind) ? [await accountRow(tenantId, kind, userId)] : await db.select().from(integrations).where(and(
    eq(integrations.tenantId, tenantId), eq(integrations.kind, kind),
    perUser(kind) && userId ? eq(integrations.userId, userId) : isNull(integrations.userId)));
  if (!row) return null;
  try { return decrypt<T>(row.config); } catch { return null; }
}

/* Where a connection lives: account keys belong to the user alone, mailboxes to user + tenant, the rest to the tenant */
const scope = (tenantId: number, kind: IntegKind, userId: number | null) =>
  account(kind) ? { tenantId: null, userId } : { tenantId, userId: perUser(kind) ? userId : null };

export async function setInteg(tenantId: number, kind: IntegKind, userId: number | null, config: object, detail = "") {
  await removeInteg(tenantId, kind, userId);
  await db.insert(integrations).values({ ...scope(tenantId, kind, userId), kind, config: encrypt(config), detail });
}

export async function removeInteg(tenantId: number, kind: IntegKind, userId: number | null) {
  const s = scope(tenantId, kind, userId);
  await db.delete(integrations).where(and(eq(integrations.kind, kind),
    s.tenantId ? eq(integrations.tenantId, s.tenantId) : isNull(integrations.tenantId),
    s.userId ? eq(integrations.userId, s.userId) : isNull(integrations.userId)));
}

/* Status for the settings screen: tenant-wide, mailboxes of the current user in this tenant, account keys of the current user */
export async function integStatus(tenantId: number, userId: number) {
  const rows = [
    ...await db.select({ kind: integrations.kind, userId: integrations.userId, detail: integrations.detail }).from(integrations).where(eq(integrations.tenantId, tenantId)),
    ...await db.select({ kind: integrations.kind, userId: integrations.userId, detail: integrations.detail }).from(integrations).where(and(isNull(integrations.tenantId), eq(integrations.userId, userId))),
  ];
  const out: Record<string, { on: boolean; detail: string }> = {};
  for (const i of INTEG) {
    const r = rows.find(x => x.kind === i.k && (i.perUser || i.account ? x.userId === userId : x.userId === null));
    out[i.k] = { on: !!r, detail: r?.detail || "" };
  }
  return out;
}
