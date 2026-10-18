import { eq } from "drizzle-orm";
import { db, leads } from "@/db";
import { HttpError, assertMember, body, checkEmail, idOf, route } from "@/lib/api";
import { attachCompanies } from "@/lib/companies";
import { cleanLead } from "@/lib/lead-fields";
import { setLeadStatus } from "@/lib/outreach";

type Ctx = { params: Promise<{ id: string }> };
const OK = ["neu", "freigabe", "angeschrieben", "beantwortet", "unzustellbar", "dublette"];

/* Status change and/or edited fields; a new company name moves the contact to that company */
export const PATCH = route<Ctx>(async (req, { params }, me) => {
  const id = await idOf(params, "Lead"), b = await body(req);
  const [l] = await db.select().from(leads).where(eq(leads.id, id));
  if (!l) throw new HttpError(404, "Lead nicht gefunden");
  await assertMember(me, l.tenantId, "Lead");
  const v = cleanLead(b);
  if (v.company === "") throw new HttpError(400, "Firma fehlt");
  if (v.email !== undefined && v.email.toLowerCase() !== l.email.toLowerCase()) await checkEmail(l.tenantId, v.email, id);
  if (Object.keys(v).length) {
    const moved = v.company !== undefined && v.company !== l.company;
    await db.update(leads).set({ ...v, ...(moved ? { companyId: null } : {}) }).where(eq(leads.id, id));
    if (moved) await attachCompanies(l.tenantId);
  }
  if (Array.isArray(b.tenders)) {
    const tenders = (b.tenders as { t?: unknown; s?: unknown; f?: unknown }[]).map(x => ({ t: String(x.t ?? "").slice(0, 300), s: String(x.s ?? "").slice(0, 200), f: String(x.f ?? "").slice(0, 20) })).filter(x => x.t).slice(0, 10);
    await db.update(leads).set({ tenders }).where(eq(leads.id, id));
  }
  if (b.status !== undefined && b.status !== l.status) {
    if (typeof b.status !== "string" || !OK.includes(b.status)) throw new HttpError(400, "Unbekannter Status");
    await setLeadStatus(l.tenantId, id, b.status);
  }
});

export const DELETE = route<Ctx>(async (_req, { params }, me) => {
  const [l] = await db.select().from(leads).where(eq(leads.id, await idOf(params, "Lead")));
  if (!l) throw new HttpError(404, "Lead nicht gefunden");
  await assertMember(me, l.tenantId, "Lead");
  await db.delete(leads).where(eq(leads.id, l.id));
});
