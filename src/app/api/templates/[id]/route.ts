import { and, eq, ne } from "drizzle-orm";
import { db, messages, templates, tenants } from "@/db";
import { HttpError, assertMember, body, idOf, route } from "@/lib/api";
import { PLACEHOLDERS } from "@/lib/fill";
import { unknownPlaceholders } from "@/lib/playbook";

type Ctx = { params: Promise<{ id: string }> };

export const PUT = route<Ctx>(async (req, { params }, me) => {
  const id = await idOf(params, "Vorlage"), b = await body(req);
  const [t] = await db.select().from(templates).where(eq(templates.id, id));
  if (!t) throw new HttpError(404, "Vorlage nicht gefunden");
  await assertMember(me, t.tenantId, "Vorlage");
  if (b.active === false) {
    const others = await db.select().from(templates).where(and(eq(templates.tenantId, t.tenantId), ne(templates.id, id), eq(templates.active, true)));
    if (!others.length) throw new HttpError(400, "Mindestens eine Variante muss aktiv bleiben");
  }
  const set: Partial<typeof templates.$inferInsert> = {};
  for (const k of ["name", "tone", "subject", "body"] as const) if (k in b) {
    if (typeof b[k] !== "string") throw new HttpError(400, "Ungültige Eingabe");
    set[k] = b[k];
  }
  if ("active" in b) {
    if (typeof b.active !== "boolean") throw new HttpError(400, "Ungültige Eingabe");
    set.active = b.active;
  }
  if (!Object.keys(set).length) return;
  const text = `${set.subject ?? ""} ${set.body ?? ""}`;
  if (/{{|}}/.test(text.replace(/{{[^{}]*}}/g, ""))) throw new HttpError(400, "Platzhalter unvollständig");
  const [tn] = await db.select({ tenders: tenants.tenders }).from(tenants).where(eq(tenants.id, t.tenantId));
  const unknown = unknownPlaceholders(text, PLACEHOLDERS(!!tn?.tenders));
  if (unknown.length) throw new HttpError(400, `Unbekannte Platzhalter: ${unknown.join(", ")}`);
  if (set.active ?? t.active) {
    if (!(set.subject ?? t.subject).trim()) throw new HttpError(400, "Betreff fehlt");
    if (!(set.body ?? t.body).trim()) throw new HttpError(400, "Text fehlt");
  }
  await db.update(templates).set(set).where(eq(templates.id, id));
});

/* Only a template nothing was written with; sent mails and drafts keep their variant key */
export const DELETE = route<Ctx>(async (_req, { params }, me) => {
  const id = await idOf(params, "Vorlage");
  const [t] = await db.select().from(templates).where(eq(templates.id, id));
  if (!t) throw new HttpError(404, "Vorlage nicht gefunden");
  await assertMember(me, t.tenantId, "Vorlage");
  if (t.active) throw new HttpError(400, "Aktive Vorlagen erst pausieren");
  const [used] = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.tenantId, t.tenantId), eq(messages.variant, t.key))).limit(1);
  if (used) throw new HttpError(400, "Mit dieser Vorlage wurden schon Nachrichten geschrieben");
  await db.delete(templates).where(eq(templates.id, id));
});
