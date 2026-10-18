/* npx tsx scripts/qa-user.ts — QA login with its own empty tenant for the automated tests; writes QA_EMAIL/QA_PASSWORD to .env.local */
import { config } from "dotenv";
config({ path: ".env.local" });
import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

async function main() {
  const { db, users } = await import("../src/db");
  const { hashPassword } = await import("../src/lib/crypto");
  const { createTenant } = await import("../src/lib/tenants");
  const { eq } = await import("drizzle-orm");
  const email = "qa@salesmonster.invalid";
  const [have] = await db.select().from(users).where(eq(users.email, email));
  if (have) return console.log("QA-User existiert");
  const pw = randomBytes(12).toString("base64url");
  const [u] = await db.insert(users).values({ email, name: "QA Test", short: "QA", passwordHash: hashPassword(pw) }).returning();
  await createTenant("QA Testfirma", "example.com", u.id);
  appendFileSync(".env.local", `\nQA_EMAIL=${email}\nQA_PASSWORD=${pw}\n`);
  console.log("QA-User angelegt");
}
main().then(() => process.exit(0));
