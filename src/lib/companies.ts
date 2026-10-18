import { and, eq, isNull } from "drizzle-orm";
import { companies, db, leads } from "@/db";
import { addrsOf, modeOf } from "./company-mode";

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

/* The messages for the open contacts of one company. People without an own address are written
   to through the company's shared one; `known` are addresses of contacts written to before. */
export function plan(c: { mode: string; email: string }, contacts: Lead[], known: string[] = []): Unit[] {
  const addrs = addrsOf(contacts).length ? addrsOf(contacts) : addrsOf(known.map(email => ({ email })));
  if (!addrs.length) return contacts.filter(l => l.linkedin).map(l => ({ leads: [l], to: [] }));
  const pool = addrs.map(email => ({ email }));
  const m = modeOf(c, pool);
  if (m.mode === "einzeln") {
    const shared = addrs.includes(c.email.toLowerCase()) ? c.email.toLowerCase() : addrs[0];
    return contacts.map(l => ({ leads: [l], to: [l.email.trim() || shared] }));
  }
  return [{ leads: contacts, to: m.to }];
}
