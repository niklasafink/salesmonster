/* npx tsx scripts/backfill-accounts.ts <tenant-slug> [max dollars, default 3]
   Runs the account rating (contacts from HubSpot and mailboxes, company profiles, ratings) until nothing is left or the money is spent.
   Costs are what OpenRouter reported, as the Kosten page shows them. */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

async function main() {
  const [slug, max = "3"] = process.argv.slice(2);
  const { and, eq, gte, sql } = await import("drizzle-orm");
  const { db, tenants, aiUsage } = await import("../src/db");
  const { refreshAccounts } = await import("../src/lib/ratings");
  const [t] = await db.select().from(tenants).where(eq(tenants.slug, slug));
  if (!t) throw new Error("Mandant nicht gefunden");
  const start = new Date();
  const spent = async () => Number((await db.select({ c: sql<number>`coalesce(sum(${aiUsage.cost}), 0)` }).from(aiUsage)
    .where(and(eq(aiUsage.tenantId, t.id), gte(aiUsage.startedAt, start))))[0].c) / 1e6;
  for (let round = 1; round <= 20; round++) {
    const r = await refreshAccounts(t.id);
    if (!r) throw new Error("Kein Bewertungsprofil");
    const p = r.profiles as { judged: number; web: number; failed: number; error?: string };
    console.log(`Runde ${round}: Kontakte ${r.touches.contacts}, Jev ${r.touches.judged}, Firmen ${p.judged}, Websuche ${p.web}, Fehler ${p.failed + r.touches.failed}${p.error ? ` (${p.error})` : ""}${r.touches.error ? ` [${r.touches.error.slice(0, 80)}]` : ""} · bisher ${(await spent()).toFixed(3)} $`);
    if (!p.judged && !p.web && !r.touches.judged) break;
    if (await spent() >= Number(max)) { console.log("Budget erreicht"); break; }
  }
}
main().then(() => process.exit(0), e => { console.error(e.message); process.exit(1); });
