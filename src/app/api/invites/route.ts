import { randomBytes } from "node:crypto";
import { db, invites } from "@/db";
import { body, route, tenantBySlug } from "@/lib/api";
import { acceptInvite } from "@/lib/invites";

/* New invite link for a tenant the caller belongs to */
export const POST = route(async (req, _c, me) => {
  const b = await body(req);
  if (b.accept) { await acceptInvite(String(b.accept), me.id); return; }
  const t = await tenantBySlug(String(b.t || ""), me);
  const token = randomBytes(18).toString("base64url");
  await db.insert(invites).values({ tenantId: t.id, token, createdBy: me.id });
  return { url: `${new URL(req.url).origin}/registrieren?einladung=${token}` };
});
