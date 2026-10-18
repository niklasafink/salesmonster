import { and, eq, isNull } from "drizzle-orm";
import { companies, db, leads } from "@/db";
import { modeOf } from "./company-mode";

type Lead = typeof leads.$inferSelect;

export const norm = (s: string) => s.toLowerCase().replace(/gmbh\s*&\s*co\.?\s*kg|gmbh|ag|kg|se|e\.k\.|ug|\(haftungsbeschränkt\)|[^a-z0-9äöüß]/g, "");

/* Puts every lead of the tenant that has no company yet into one, by normalized name */
export async function attachCompanies(tenantId: number) {
  const loose = await db.select({ id: leads.id, company: leads.company }).from(leads).where(and(eq(leads.tenantId, tenantId), isNull(leads.companyId)));
  if (!loose.length) return;
  const have = new Map((await db.select().from(companies).where(eq(companies.tenantId, tenantId))).map(c => [c.key, c.id]));
  const groups = new Map<string, { name: string; ids: number[] }>();
  for (const l of loose) {
    const key = norm(l.company) || `lead-${l.id}`;
    const g = groups.get(key) || { name: l.company.trim(), ids: [] };
    g.ids.push(l.id); groups.set(key, g);
  }
  for (const [key, g] of groups) {
    let id = have.get(key);
    if (!id) {
      const [c] = await db.insert(companies).values({ tenantId, key, name: g.name }).onConflictDoNothing().returning();
      id = c?.id ?? (await db.select().from(companies).where(and(eq(companies.tenantId, tenantId), eq(companies.key, key))))[0].id;
      have.set(key, id);
    }
    for (const lid of g.ids) await db.update(leads).set({ companyId: id }).where(eq(leads.id, lid));
  }
}

export type Unit = { leads: Lead[]; to: string[] };

/* The messages for the open contacts of one company */
export function plan(c: { mode: string; email: string }, contacts: Lead[]): Unit[] {
  const mail = contacts.filter(l => l.email), social = contacts.filter(l => !l.email && l.linkedin);
  const out: Unit[] = social.map(l => ({ leads: [l], to: [] }));
  if (!mail.length) return out;
  const m = modeOf(c, mail);
  if (m.mode === "einzeln") return [...mail.map(l => ({ leads: [l], to: [l.email.trim()] })), ...out];
  return [{ leads: mail, to: m.to }, ...out];
}
