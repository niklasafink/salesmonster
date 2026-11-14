/* Creates the LinkedIn sender for a portal user (or gives it a new token) and prints the worker token once.
   Usage: npx tsx scripts/li-sender.ts <email> ; the old token stops working at once. */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

async function main() {
  const email = (process.argv[2] || "").trim().toLowerCase();
  if (!email) throw new Error("Aufruf: npx tsx scripts/li-sender.ts <email>");
  const { db, users } = await import("@/db");
  const { eq, sql } = await import("drizzle-orm");
  const { issueSender } = await import("@/lib/linkedin");
  const [u] = await db.select().from(users).where(eq(sql`lower(${users.email})`, email));
  if (!u) throw new Error(`Kein Portal-Konto mit ${email}`);
  const { sender, token } = await issueSender(u.id);
  console.log(`Absender ${sender.id} für ${u.email}.\nIn ~/.salesmonster/linkedin.env eintragen:\nLI_TOKEN=${token}`);
}
main().then(() => process.exit(0), e => { console.error(e.message); process.exit(1); });
