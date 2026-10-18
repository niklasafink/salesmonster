import { and, eq } from "drizzle-orm";
import { db, members } from "@/db";
import { HttpError, numId, qp, route, tenantBySlug } from "@/lib/api";

/* Removes someone from a tenant; leaving yourself is allowed while others remain */
export const DELETE = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me), uid = numId(qp(req, "user"), "Person");
  const rest = await db.select({ id: members.id }).from(members).where(eq(members.tenantId, t.id));
  if (rest.length < 2) throw new HttpError(400, "Die letzte Person kann nicht entfernt werden");
  await db.delete(members).where(and(eq(members.tenantId, t.id), eq(members.userId, uid)));
});
