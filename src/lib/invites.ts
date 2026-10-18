import { and, eq, gt, isNull } from "drizzle-orm";
import { db, invites, members } from "@/db";
import { HttpError } from "./api";

const DAYS = 7;

const open = (token: string) => and(eq(invites.token, token), isNull(invites.usedAt), gt(invites.createdAt, new Date(Date.now() - DAYS * 864e5)));
const invalid = () => new HttpError(400, "Einladung ungültig oder abgelaufen");

/* Checked before an account is created, so a bad link does not leave one behind */
export async function checkInvite(token: string) {
  const [inv] = await db.select({ id: invites.id }).from(invites).where(open(token));
  if (!inv) throw invalid();
}

/* Joins the tenant behind an open invite; an unknown, used or expired token is an error */
export async function acceptInvite(token: string, userId: number) {
  const [inv] = await db.update(invites).set({ usedAt: new Date() }).where(open(token)).returning();
  if (!inv) throw invalid();
  await db.insert(members).values({ tenantId: inv.tenantId, userId }).onConflictDoNothing();
}
