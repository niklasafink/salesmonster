import { eq } from "drizzle-orm";
import { companies, db, leads } from "@/db";
import { HttpError, assertMember, idOf, route } from "@/lib/api";
import { crmHistory } from "@/lib/crm-history";

type Ctx = { params: Promise<{ id: string }> };

/* What HubSpot logged on the person or their company (lib/crm-history.ts), with the HubSpot record itself.
   Apart from ../route.ts, as HubSpot takes longer than the portal's own history */
export const GET = route<Ctx>(async (_req, { params }, me) => {
  const [l] = await db.select().from(leads).where(eq(leads.id, await idOf(params, "Lead")));
  if (!l) throw new HttpError(404, "Lead nicht gefunden");
  await assertMember(me, l.tenantId, "Lead");
  const [co] = l.companyId ? await db.select({ hs: companies.hubspotId }).from(companies).where(eq(companies.id, l.companyId)) : [];
  const { acts, hs, error } = await crmHistory(l.tenantId, l, co?.hs || "");
  return { acts: acts.map(({ id: _, ...a }) => ({ ...a, at: new Date(a.at).toISOString() })), hs, hsError: error };
});
