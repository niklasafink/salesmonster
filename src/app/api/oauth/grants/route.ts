import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db, oauthGrants } from "@/db";
import { HttpError, numId, qp, route } from "@/lib/api";
import { resource } from "@/lib/oauth";

/* Claude connector of the signed-in user: its URL and the connected (exchanged, not revoked) grants */
export const GET = route(async (req, _, user) => ({
  url: resource(req),
  grants: await db.select({ id: oauthGrants.id, clientName: oauthGrants.clientName, createdAt: oauthGrants.createdAt, lastUsedAt: oauthGrants.lastUsedAt })
    .from(oauthGrants).where(and(eq(oauthGrants.userId, user.id), isNull(oauthGrants.revokedAt), isNotNull(oauthGrants.refreshHash))).orderBy(desc(oauthGrants.createdAt)),
}));

export const DELETE = route(async (req, _, user) => {
  const [g] = await db.update(oauthGrants).set({ revokedAt: new Date(), refreshHash: null })
    .where(and(eq(oauthGrants.id, numId(qp(req, "id"), "Zugriff")), eq(oauthGrants.userId, user.id), isNull(oauthGrants.revokedAt))).returning({ id: oauthGrants.id });
  if (!g) throw new HttpError(404, "Zugriff nicht gefunden");
});
