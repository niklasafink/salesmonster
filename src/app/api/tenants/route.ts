import { eq, sql } from "drizzle-orm";
import { db, members, templates, tenants } from "@/db";
import { HttpError, route } from "@/lib/api";

const slugify = (s: string) => s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);

export const POST = route(async (req, _c, me) => {
  const { name, domain } = await req.json();
  if (!String(name || "").trim() || !String(domain || "").trim()) throw new HttpError(400, "Name und Domain angeben");
  let slug = slugify(name) || "mandant";
  const [dupe] = await db.select().from(tenants).where(eq(tenants.slug, slug));
  if (dupe) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
  const initials = name.replace(/&/g, "").split(/\s+/).filter(Boolean).map((w: string) => w[0]).slice(0, 2).join("").toUpperCase();
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(members).where(eq(members.userId, me.id));
  const [t] = await db.insert(tenants).values({
    slug, name: name.trim(), initials, domain: domain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""), tenders: false, position: n,
    settings: { leadsPerDay: 10, cooldownDays: 90, prompt: `Du recherchierst jeden Abend 10 Ansprechpartner für ${name.trim()}.

Rollen: Geschäftsführung, Leitung Vertrieb
Branchen:
Regionen: Deutschland
Größe: 20 bis 500 Mitarbeitende

Suche Unternehmen mit einem aktuellen Anlass, etwa neue Niederlassung, Finanzierung, Führungswechsel oder offene Vertriebsstellen.
Gib den Anlass als {{aufhaenger}} zurück, und zwar als Substantivgruppe im Nominativ, zum Beispiel „die neue Niederlassung in Halle“.
Überspringe Unternehmen, die bereits in HubSpot stehen oder in den letzten 90 Tagen angeschrieben wurden.` },
  }).returning();
  await db.insert(members).values({ tenantId: t.id, userId: me.id });
  const sign = `Viele Grüße\n{{absender}}\n${t.name}`;
  await db.insert(templates).values([
    { tenantId: t.id, key: "A", name: "Anlass", tone: "sie", subject: "Kurze Frage zu {{firma}}", body: `{{anrede}}\n\nAnlass meiner Nachricht ist {{aufhaenger}}. [Ein Satz, wobei ${t.name} hilft.]\n\nWäre ein 20-minütiges Gespräch nächste Woche interessant?\n\n${sign}` },
    { tenantId: t.id, key: "B", name: "Locker", tone: "du", subject: "{{firma}}", body: `{{anrede}}\n\nkurz zum Anlass: {{aufhaenger}}. [Ein Satz, wobei ${t.name} hilft.]\n\nLust auf einen kurzen Austausch?\n\nBeste Grüße\n{{absender}}` },
    { tenantId: t.id, key: "C", name: "Kundenbeispiel", tone: "sie", subject: "[Betreff zum Kundenbeispiel]", active: false, body: `{{anrede}}\n\n[Kundenbeispiel mit echten Zahlen einsetzen]. Anlass meiner Nachricht ist {{aufhaenger}}.\n\nSoll ich Ihnen zeigen, wie das konkret aussah?\n\n${sign}` },
  ]);
  return { slug };
});
