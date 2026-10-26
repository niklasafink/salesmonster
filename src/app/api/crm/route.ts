import { and, count, eq, isNotNull } from "drizzle-orm";
import { db, leads } from "@/db";
import { HttpError, body, qp, route, tenantBySlug } from "@/lib/api";
import { crmSyncOf, setCrmRule, syncCrm } from "@/lib/crm-sync";
import { hubspotToken } from "@/lib/hubspot";

async function state(tenantId: number) {
  const [s, [n]] = await Promise.all([crmSyncOf(tenantId), db.select({ n: count() }).from(leads).where(and(eq(leads.tenantId, tenantId), isNotNull(leads.crmAt)))]);
  return { hubspot: !!await hubspotToken(tenantId), property: s?.property || "", value: s?.value || "", status: s?.status || "aus", error: s?.error || "",
    lastRunAt: s?.lastRunAt || null, imported: s?.imported || 0, updated: s?.updated || 0, contacts: n.n };
}

export const GET = route(async (req, _c, me) => state((await tenantBySlug(qp(req, "t"), me)).id));

/* the HubSpot property that marks a registration; empty turns the sync off */
export const PUT = route(async (req, _c, me) => {
  const b = await body(req), t = await tenantBySlug(String(b.t || ""), me);
  if (typeof b.property !== "string" || (b.value !== undefined && typeof b.value !== "string")) throw new HttpError(400, "Ungültige Eingabe");
  if (b.property.length > 100 || String(b.value || "").length > 200) throw new HttpError(400, "Zu lang");
  await setCrmRule(t.id, b.property, String(b.value || ""));
  return state(t.id);
});

/* one step now; the page calls again while the status says läuft */
export const POST = route(async (req, _c, me) => {
  const b = await body(req), t = await tenantBySlug(String(b.t || ""), me);
  const s = await crmSyncOf(t.id);
  if (!s?.property) throw new HttpError(400, "Erst die HubSpot-Eigenschaft für Registrierungen angeben");
  if (!await hubspotToken(t.id)) throw new HttpError(400, "HubSpot ist nicht verbunden");
  await syncCrm(t, 25_000);
  return state(t.id);
});
