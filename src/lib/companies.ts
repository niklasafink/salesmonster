import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { companies, db, leads } from "@/db";
import { addrsOf, modeOf } from "./company-mode";

type Lead = typeof leads.$inferSelect;

export const norm = (s: string) => s.toLowerCase().replace(/gmbh\s*&\s*co\.?\s*kg|gmbh|ag|kg|se|e\.k\.|ug|\(haftungsbeschränkt\)|[^a-z0-9äöüß]/g, "");

/* Puts every lead of the tenant that has no company yet into one, by normalized name; set-based, so ten thousand loose leads
   cost a handful of statements instead of one per lead */
export async function attachCompanies(tenantId: number) {
  const loose = await db.select({ id: leads.id, company: leads.company }).from(leads).where(and(eq(leads.tenantId, tenantId), isNull(leads.companyId)));
  if (!loose.length) return;
  const groups = new Map<string, { name: string; ids: number[] }>();
  for (const l of loose) {
    const key = norm(l.company) || `lead-${l.id}`;
    const g = groups.get(key) || { name: l.company.trim(), ids: [] };
    g.ids.push(l.id); groups.set(key, g);
  }
  const keys = [...groups.keys()];
  for (let i = 0; i < keys.length; i += 1000)
    await db.insert(companies).values(keys.slice(i, i + 1000).map(key => ({ tenantId, key, name: groups.get(key)!.name || "–" }))).onConflictDoNothing();
  const have = new Map<string, number>();
  for (let i = 0; i < keys.length; i += 1000)
    for (const c of await db.select({ id: companies.id, key: companies.key }).from(companies).where(and(eq(companies.tenantId, tenantId), inArray(companies.key, keys.slice(i, i + 1000)))))
      have.set(c.key, c.id);
  const pairs = [...groups].flatMap(([key, g]) => g.ids.map(id => [id, have.get(key)!] as const)).filter(([, c]) => c);
  for (let i = 0; i < pairs.length; i += 1000) {
    const values = sql.join(pairs.slice(i, i + 1000).map(([id, c]) => sql`(${id}::int, ${c}::int)`), sql`, `);
    await db.execute(sql`update leads set company_id = v.c from (values ${values}) as v(id, c) where leads.id = v.id and leads.company_id is null`);
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
