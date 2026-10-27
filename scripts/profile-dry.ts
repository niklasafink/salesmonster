/* npx tsx scripts/profile-dry.ts <tenant-slug> [--web] <company name> …
   Judges the named companies of a tenant by its rubric (lib/rubrics.ts) and prints profile and rating; writes nothing.
   Costs a few cents on the tenant's OpenRouter key. */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

async function main() {
  const args = process.argv.slice(2), web = args.includes("--web");
  const [slug, ...names] = args.filter(a => a !== "--web");
  const { and, eq, getTableColumns, inArray, notInArray } = await import("drizzle-orm");
  const { db, tenants, companies, leads } = await import("../src/db");
  const { rubricOf } = await import("../src/lib/rubrics");
  const { judge, viewOf } = await import("../src/lib/company-profile");
  const { rateAccount } = await import("../src/lib/account-rating");
  const { jevKey } = await import("../src/lib/jev");
  const [t] = await db.select().from(tenants).where(eq(tenants.slug, slug));
  const r = t && rubricOf(t);
  if (!r) throw new Error("Kein Bewertungsprofil");
  const key = await jevKey(t.id);
  if (!key) throw new Error("Kein OpenRouter-Schlüssel");
  /* only columns that exist before the schema change */
  const cos = (await db.select({ id: companies.id, name: companies.name, domain: companies.domain }).from(companies)
    .where(and(eq(companies.tenantId, t.id), inArray(companies.name, names)))).map(c => ({ ...c, profile: null }));
  const { touch: _t, ...cols } = getTableColumns(leads);
  const people = (await db.select(cols).from(leads).where(and(eq(leads.tenantId, t.id), inArray(leads.companyId, [0, ...cos.map(c => c.id)]), notInArray(leads.status, ["papierkorb", "dublette"])))).map(p => ({ ...p, touch: null }));
  const views = cos.map(c => viewOf(c, people.filter(p => p.companyId === c.id))).filter(v => v.personen);
  const out = [];
  let cost = 0;
  for (let i = 0; i < views.length; i += web ? 1 : 10) {
    const { got, model, sources, cost: c } = await judge(key, r, views.slice(i, i + (web ? 1 : 10)), web);
    cost += c;
    for (const g of got) {
      const v = views.find(x => x.id === g.id)!, p = people.find(x => x.companyId === g.id)!;
      const a = rateAccount({ ...g, web, sources, model, hash: "", at: "" }, { email: p.email, emailType: p.emailType, role: p.role, stage: p.stage, crmAt: p.crmAt, vote: p.vote, inbound: !p.prospect, colleagues: v.personen - 1 }, r);
      out.push({ firma: v.firma, rating: a.rating, note: a.grade, typ: a.type, size: g.size, ma: g.employees, fit: g.fit, signals: g.signals, sure: g.sure, why: g.why, sources, model });
    }
  }
  out.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
  for (const o of out) console.log(JSON.stringify(o));
  console.log(`Kosten: ${cost.toFixed(4)} $ für ${views.length} Firmen`);
}
main().then(() => process.exit(0), e => { console.error(e.message); process.exit(1); });
