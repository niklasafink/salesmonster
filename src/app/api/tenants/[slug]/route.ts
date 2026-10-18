import { eq } from "drizzle-orm";
import { db, tenants } from "@/db";
import { HttpError, body, route, tenantBySlug } from "@/lib/api";
import { choiceOf } from "@/lib/ai";
import { planOf } from "@/lib/schedule";

type Ctx = { params: Promise<{ slug: string }> };

export const PATCH = route<Ctx>(async (req, { params }, me) => {
  const t = await tenantBySlug((await params).slug, me), b = await body(req);
  const set: Partial<typeof tenants.$inferInsert> = {};
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (b.settings !== undefined && !obj(b.settings) || b.invoice !== undefined && !obj(b.invoice)) throw new HttpError(400, "Ungültige Eingabe");
  if (obj(b.settings)) {
    const s = { ...t.settings, ...b.settings };
    if (typeof s.prompt !== "string") throw new HttpError(400, "Ungültige Eingabe");
    s.leadsPerDay = Math.max(1, Math.min(30, Math.round(Number(s.leadsPerDay)) || 10));
    s.roundsPerDay = Math.max(0, Math.min(24, Math.round(Number(s.roundsPerDay)) || 0));
    s.holdTop = s.holdTop === true;
    const p = planOf(s);
    s.sendDays = p.days; s.sendFrom = Math.max(0, Math.min(23, p.from)); s.sendTo = Math.max(s.sendFrom + 1, Math.min(24, p.to));
    if (typeof s.sendpilotCampaign !== "string" || !s.sendpilotCampaign) delete s.sendpilotCampaign;
    /* "claude" or "openrouter:<model>"; null goes back to the default order */
    if ("ai" in b.settings) {
      const c = b.settings.ai === null ? null : choiceOf(String(b.settings.ai));
      if (b.settings.ai !== null && !c) throw new HttpError(400, "KI unbekannt");
      if (c) s.ai = c; else delete s.ai;
    }
    set.settings = s as typeof t.settings;
  }
  if (obj(b.invoice)) {
    if (!t.invoice) throw new HttpError(400, "Rechnungen sind für diesen Mandanten nicht eingerichtet");
    set.invoice = { ...t.invoice, ...b.invoice, seller: { ...t.invoice.seller, ...(obj(b.invoice.seller) ? b.invoice.seller : {}) } } as typeof t.invoice;
  }
  if (typeof b.tenders === "boolean") set.tenders = b.tenders;
  if (typeof b.name === "string" && b.name.trim()) set.name = b.name.trim();
  if (!Object.keys(set).length) return;
  await db.update(tenants).set(set).where(eq(tenants.id, t.id));
});
