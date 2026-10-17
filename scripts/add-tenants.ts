/* npx tsx scripts/add-tenants.ts  — adds Conformis GRC and Chetti for Niklas; skips existing domains */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db, tenants, users } = await import("../src/db");
  const { createTenant } = await import("../src/lib/tenants");
  const { eq } = await import("drizzle-orm");
  const [me] = await db.select().from(users).where(eq(users.email, "niklas@vergabehero.eu"));
  if (!me) throw new Error("Nutzer fehlt");
  for (const [name, domain] of [["Conformis GRC", "conformisgrc.com"], ["Chetti", "chettiai.de"]]) {
    const [dupe] = await db.select().from(tenants).where(eq(tenants.domain, domain));
    console.log(dupe ? `${name}: gibt es schon (${dupe.slug})` : `${name}: angelegt (${await createTenant(name, domain, me.id)})`);
  }
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
