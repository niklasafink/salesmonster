import { and, eq, gt, isNull } from "drizzle-orm";
import { db, invites, members } from "@/db";
import { HttpError } from "./api";

const DAYS = 7;

/* Joins the tenant behind an open invite; an unknown, used or expired token is an error */
export async function acceptInvite(token: string, userId: number) {
  const since = new Date(Date.now() - DAYS * 864e5);
  const [inv] = await db.update(invites).set({ usedAt: new Date() })
    .where(and(eq(invites.token, token), isNull(invites.usedAt), gt(invites.createdAt, since))).returning();
  if (!inv) throw new HttpError(400, "Einladung ungültig oder abgelaufen");
  await db.insert(members).values({ tenantId: inv.tenantId, userId }).onConflictDoNothing();
}
