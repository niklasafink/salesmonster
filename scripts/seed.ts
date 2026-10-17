/* npx tsx scripts/seed.ts  — idempotent; prints passwords for new users */
import { config } from "dotenv";
config({ path: ".env.local" });
import { randomBytes } from "node:crypto";

async function main() {
  const { db, members, tenants, templates, users } = await import("../src/db");
  const { hashPassword } = await import("../src/lib/crypto");
  const { eq } = await import("drizzle-orm");

  const people = [
    { email: "niklas@vergabehero.eu", name: "Niklas Fink", short: "Niklas", phone: "+49 (0) 1523 4203042" },
    { email: "lasse@vergabehero.eu", name: "Lasse Schröder", short: "Lasse", phone: "+49 (0) 1517 0007928" },
  ];
  for (const p of people) {
    const [have] = await db.select().from(users).where(eq(users.email, p.email));
    if (have) continue;
    const pw = randomBytes(9).toString("base64url");
    await db.insert(users).values({ ...p, passwordHash: hashPassword(pw) });
    console.log(`USER ${p.email} ${pw}`);
  }

  /* Vergabehero is Niklas' workspace only; everyone else creates their own */
  const [niklas] = await db.select().from(users).where(eq(users.email, "niklas@vergabehero.eu"));
  const [vh] = await db.select().from(tenants).where(eq(tenants.slug, "vh"));
  if (vh) {
    await db.insert(members).values({ tenantId: vh.id, userId: niklas.id }).onConflictDoNothing();
    console.log("Mandant vh existiert");
    return;
  }
  const [t] = await db.insert(tenants).values({
    slug: "vh", name: "Vergabehero", initials: "VH", domain: "vergabehero.eu", tenders: true, position: 0,
    settings: { leadsPerDay: 10, cooldownDays: 90, prompt: `Du recherchierst jeden Abend 10 neue Ansprechpartner für Vergabehero.

Rollen: Bid-Manager, Angebotsmanagement, Kalkulation, Leitung Vertrieb
Branchen: Tiefbau, Gebäudetechnik, Facility Management, IT-Dienstleistung, Elektro
Regionen: Deutschland
Größe: 20 bis 500 Mitarbeitende

Nimm zuerst Leads aus der Lead-Datenbank mit Status „Neu“ und ergänze fehlende Ansprechpartner und E-Mail-Adressen. Recherchiere nur für den Rest neue Unternehmen.
Gibt es keine persönliche Adresse, nimm die info@-Adresse und markiere sie.
Überspringe Unternehmen, die bereits in HubSpot stehen oder in den letzten 90 Tagen von Niklas oder Lasse angeschrieben wurden.
Suche je Unternehmen bis zu drei laufende Ausschreibungen, die zum Gewerk passen. Gib nur Titel und Vergabestelle aus.
Schreibe kurz, ohne Floskeln, höchstens 90 Wörter.` },
    invoice: {
      logo: "vergabe|hero", title: "Rechnung – Vergabehero", nextNo: 1006,
      seller: { name: "Neura Labs UG (haftungsbeschränkt)", street: "Auf der Heidwende 7", city: "27726 Worpswede", hrb: "HRB 212113", court: "Walsrode",
        gf: "Moritz Landwehr", tax: "DE450428774", iban: "DE35 1001 0123 2774 2846 92", bic: "QNTODEB2XXX", email: "rechnung@vergabehero.eu" },
      plans: [
        { key: "starter", n: "Starter", m: 69, label: "Vergabehero Starter" },
        { key: "premium", n: "Premium", m: 199, label: "Vergabehero Premium" },
        { key: "enterprise", n: "Enterprise", m: 499, label: "Vergabehero Enterprise" },
        { key: "design", n: "Design-Kunde", m: 50, label: "Vergabehero Premium (Design-Partner)", noFree: true },
      ],
    },
  }).returning();
  await db.insert(members).values({ tenantId: t.id, userId: niklas.id });

  await db.insert(templates).values([
    { tenantId: t.id, key: "A", name: "Kurz", tone: "sie", subject: "Drei Ausschreibungen für {{firma}}", body: `{{anrede}}

beim Blick auf aktuelle Vergaben sind uns drei Ausschreibungen aufgefallen, die zu {{firma}} passen könnten:

{{ausschreibungen}}

Haben Sie die schon auf dem Radar? Wir kümmern uns für Mittelständler um das Thema Ausschreibungen. Wenn das für Sie interessant ist, zeige ich Ihnen in 15 Minuten, wie das läuft.

Viele Grüße
{{absender}}
Vergabehero` },
    { tenantId: t.id, key: "B", name: "Frage zuerst", tone: "du", subject: "Ausschreibungen für {{firma}} auf dem Radar?", body: `{{anrede}}

kurze Frage: Habt ihr diese drei Ausschreibungen schon auf dem Radar?

{{ausschreibungen}}

Wir kümmern uns bei Vergabehero um das Thema Ausschreibungen. Ist das was für euch?

Beste Grüße
{{absender}}` },
    { tenantId: t.id, key: "C", name: "Nutzen zuerst", tone: "sie", subject: "Öffentliche Aufträge für {{firma}}", body: `{{anrede}}

wenn im Haus niemand Zeit für die Suche hat, gehen passende öffentliche Aufträge leicht unter. Für {{firma}} haben wir diese Woche drei gefunden:

{{ausschreibungen}}

Sollen wir für Sie regelmäßig danach suchen? Eine kurze Antwort genügt.

Freundliche Grüße
{{absender}}
Vergabehero` },
  ]);
  console.log("Mandant Vergabehero angelegt");
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
