import { and, eq, gte } from "drizzle-orm";
import { db, members, sequenceTemplates, sequences, tenants, type SeqConfig, type SeqStep } from "@/db";
import { HttpError, assertMember, body, idOf, route } from "@/lib/api";
import { proposeVariant, runSequences, scoreVariant } from "@/lib/sequences";

type Ctx = { params: Promise<{ id: string }> };

async function load(params: Ctx["params"], me: { id: number }) {
  const id = await idOf(params, "Strecke");
  const [row] = await db.select({ s: sequences, t: tenants }).from(sequences).innerJoin(tenants, eq(tenants.id, sequences.tenantId)).where(eq(sequences.id, id));
  if (!row) throw new HttpError(404, "Strecke nicht gefunden");
  await assertMember(me, row.t.id, "Strecke");
  return row;
}

const str = (v: unknown, max = 200) => { if (typeof v !== "string") throw new HttpError(400, "Ungültige Eingabe"); return v.trim().slice(0, max); };
const match = (v: unknown) => { const m = (v || {}) as Record<string, unknown>; return { property: str(m.property ?? ""), value: str(m.value ?? "") }; };

export const PUT = route<Ctx>(async (req, { params }, me) => {
  const { s, t } = await load(params, me), b = await body(req);
  const set: Partial<typeof sequences.$inferInsert> = {};
  if ("name" in b) set.name = str(b.name, 80) || s.name;
  if ("steps" in b) {
    if (!Array.isArray(b.steps) || !b.steps.length || b.steps.length > 12) throw new HttpError(400, "Ungültige Schritte");
    const steps: SeqStep[] = b.steps.map((x: { day?: unknown; name?: unknown }) => ({ day: Number(x.day), name: str(x.name ?? "", 60) }));
    if (steps.some((x, i) => !Number.isInteger(x.day) || x.day < 0 || x.day > 365 || (i && x.day <= steps[i - 1].day))) throw new HttpError(400, "Tage müssen aufsteigen");
    set.steps = steps;
  }
  if ("config" in b) {
    const c = (b.config || {}) as Record<string, unknown>, cur = s.config;
    const next: SeqConfig = { ...cur };
    if ("enter" in c) next.enter = match(c.enter);
    if ("bought" in c) next.bought = match(c.bought);
    if ("stop" in c) next.stop = match(c.stop);
    if ("trialDays" in c) { const n = Number(c.trialDays); if (!Number.isInteger(n) || n < 1 || n > 90) throw new HttpError(400, "Testphase ungültig"); next.trialDays = n; }
    if ("since" in c) { const d = new Date(str(c.since)); if (isNaN(+d)) throw new HttpError(400, "Datum ungültig"); next.since = d.toISOString(); }
    if ("senderId" in c) {
      const id = Number(c.senderId);
      const [m] = await db.select({ id: members.id }).from(members).where(and(eq(members.tenantId, t.id), eq(members.userId, id)));
      if (!m) throw new HttpError(400, "Absender gehört nicht zu diesem Unternehmen");
      next.senderId = id;
    }
    set.config = next;
  }
  if ("active" in b) {
    if (typeof b.active !== "boolean") throw new HttpError(400, "Ungültige Eingabe");
    const c = set.config || s.config;
    if (b.active && !c.enter.property) throw new HttpError(400, "Erst die HubSpot-Eigenschaft für die Registrierung festlegen");
    if (b.active && !c.senderId) throw new HttpError(400, "Erst einen Absender wählen");
    set.active = b.active;
  }
  if (Object.keys(set).length) await db.update(sequences).set(set).where(eq(sequences.id, s.id));
  /* a removed step takes its variants with it */
  if (set.steps) await db.delete(sequenceTemplates).where(and(eq(sequenceTemplates.sequenceId, s.id), gte(sequenceTemplates.step, set.steps.length)));
});

/* run now (any hour), new variant (blank copy or AI proposal), Jev score */
export const POST = route<Ctx>(async (req, { params }, me) => {
  const { s, t } = await load(params, me), b = await body(req);
  if (b.action === "run") {
    if (!s.active) throw new HttpError(400, "Strecke ist pausiert");
    return (await runSequences(t, { anyHour: true })).find(r => r.id === s.id);
  }
  if (b.action === "score") return scoreVariant(t, s, Number(b.templateId));
  const step = Number(b.step);
  if (!Number.isInteger(step) || step < 0 || step >= s.steps.length) throw new HttpError(400, "Schritt ungültig");
  if (b.action === "propose") return proposeVariant(t, s, step);
  if (b.action === "variant") {
    const all = await db.select().from(sequenceTemplates).where(and(eq(sequenceTemplates.sequenceId, s.id), eq(sequenceTemplates.step, step)));
    const key = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)).find(k => !all.some(x => x.key === k));
    if (!key) throw new HttpError(400, "Zu viele Varianten");
    const base = all[0];
    const [row] = await db.insert(sequenceTemplates).values({ sequenceId: s.id, step, key, tone: base?.tone || "sie", subject: base?.subject || "", body: base?.body || "{{anrede}}\n\n\n\nViele Grüße\n{{absender}}", active: false }).returning();
    return row;
  }
  throw new HttpError(400, "Unbekannte Aktion");
});
