import { and, eq, inArray } from "drizzle-orm";
import { db, members, messages } from "@/db";
import { route } from "@/lib/api";

/* The client renders each text (placeholders, sender name) and sends it along */
export const POST = route(async (req, _c, me) => {
  const { items } = await req.json() as { items: { id: number; finalSubject: string; finalBody: string }[] };
  const mine = db.select({ id: members.tenantId }).from(members).where(eq(members.userId, me.id));
  for (const it of items) {
    await db.update(messages).set({ status: "freigegeben", finalSubject: it.finalSubject, finalBody: it.finalBody, senderId: me.id, error: "" })
      .where(and(eq(messages.id, it.id), eq(messages.status, "entwurf"), inArray(messages.tenantId, mine)));
  }
  return { n: items.length };
});
