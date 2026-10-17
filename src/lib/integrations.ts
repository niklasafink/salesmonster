import { and, eq, isNull } from "drizzle-orm";
import { db, integrations } from "@/db";
import { decrypt, encrypt } from "./crypto";
import { INTEG, type IntegKind } from "./integ-meta";

const perUser = (k: IntegKind) => !!INTEG.find(i => i.k === k)?.perUser;

export async function getInteg<T = Record<string, string>>(tenantId: number, kind: IntegKind, userId?: number | null): Promise<T | null> {
  const [row] = await db.select().from(integrations).where(and(
    eq(integrations.tenantId, tenantId), eq(integrations.kind, kind),
    perUser(kind) && userId ? eq(integrations.userId, userId) : isNull(integrations.userId)));
  if (!row) return null;
  try { return decrypt<T>(row.config); } catch { return null; }
}

export async function setInteg(tenantId: number, kind: IntegKind, userId: number | null, config: object, detail = "") {
  const uid = perUser(kind) ? userId : null;
  await removeInteg(tenantId, kind, uid);
  await db.insert(integrations).values({ tenantId, kind, userId: uid, config: encrypt(config), detail });
}

export async function removeInteg(tenantId: number, kind: IntegKind, userId: number | null) {
  const uid = perUser(kind) ? userId : null;
  await db.delete(integrations).where(and(eq(integrations.tenantId, tenantId), eq(integrations.kind, kind),
    uid ? eq(integrations.userId, uid) : isNull(integrations.userId)));
}

/* Status for the settings screen: tenant-wide, plus mailboxes of the current user */
export async function integStatus(tenantId: number, userId: number) {
  const rows = await db.select({ kind: integrations.kind, userId: integrations.userId, detail: integrations.detail }).from(integrations).where(eq(integrations.tenantId, tenantId));
  const out: Record<string, { on: boolean; detail: string }> = {};
  for (const i of INTEG) {
    const r = rows.find(x => x.kind === i.k && (i.perUser ? x.userId === userId : x.userId === null));
    out[i.k] = { on: !!r, detail: r?.detail || "" };
  }
  return out;
}
