/* npx tsx scripts/reprofile-types.ts <tenant-slug> <type> …
   After a change to the rubric or prompt that only concerns some kinds of company: those are judged again, all others keep their
   judgement and only take the new hash, so they are not paid for twice. Then contacts, profiles and ratings run as usual. */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

async function main() {
  const [slug, ...types] = process.argv.slice(2);
  const { and, eq, notInArray, sql } = await import("drizzle-orm");
  const { db, tenants, companies, leads } = await import("../src/db");
  const { rubricOf } = await import("../src/lib/rubrics");
  const { viewOf, profileHash } = await import("../src/lib/company-profile");
  const { refreshAccounts } = await import("../src/lib/ratings");
  const [t] = await db.select().from(tenants).where(eq(tenants.slug, slug));
  const r = t && rubricOf(t);
  if (!r || !types.length) throw new Error("Mandant mit Bewertungsprofil und Typen angeben");
  const cos = await db.select({ id: companies.id, name: companies.name, domain: companies.domain, profile: companies.profile }).from(companies)
    .where(and(eq(companies.tenantId, t.id), sql`${companies.profile} is not null`));
  const people = await db.select({ companyId: leads.companyId, company: leads.company, email: leads.email, website: leads.website, city: leads.city, role: leads.role, hook: leads.hook,
    note: leads.note, research: leads.research, touch: leads.touch }).from(leads).where(and(eq(leads.tenantId, t.id), notInArray(leads.status, ["papierkorb", "dublette"])));
  let kept = 0, again = 0;
  for (const c of cos) {
    const mine = people.filter(p => p.companyId === c.id);
    if (!mine.length || !c.profile) continue;
    if (types.includes(c.profile.type)) { again++; continue; }
    const hash = profileHash(r, viewOf(c, mine));
    if (c.profile.hash !== hash) { await db.update(companies).set({ profile: { ...c.profile, hash } }).where(eq(companies.id, c.id)); kept++; }
  }
  console.log(`${kept} Profile behalten, ${again} werden neu geprüft`);
  const res = await refreshAccounts(t.id);
  console.log(JSON.stringify(res?.profiles));
}
main().then(() => process.exit(0), e => { console.error(e.message); process.exit(1); });
