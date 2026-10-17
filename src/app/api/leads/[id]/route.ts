import { eq } from "drizzle-orm";
import { db, leads } from "@/db";
import { HttpError, assertMember, route } from "@/lib/api";
import { setLeadStatus } from "@/lib/outreach";

type Ctx = { params: Promise<{ id: string }> };
const OK = ["neu", "freigabe", "angeschrieben", "beantwortet", "unzustellbar", "dublette"];

export const PATCH = route<Ctx>(async (req, { params }, me) => {
  const id = Number((await params).id), { status } = await req.json();
  if (!OK.includes(status)) throw new HttpError(400, "Unbekannter Status");
  const [l] = await db.select().from(leads).where(eq(leads.id, id));
  if (!l) throw new HttpError(404, "Lead nicht gefunden");
  await assertMember(me, l.tenantId, "Lead");
  await setLeadStatus(l.tenantId, id, status);
});

export const DELETE = route<Ctx>(async (_req, { params }, me) => {
  const [l] = await db.select().from(leads).where(eq(leads.id, Number((await params).id)));
  if (!l) throw new HttpError(404, "Lead nicht gefunden");
  await assertMember(me, l.tenantId, "Lead");
  await db.delete(leads).where(eq(leads.id, l.id));
});
