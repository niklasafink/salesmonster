import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, leads, runs, type EnrichField } from "@/db";
import { AiMissing, aiFor, type Ai } from "./ai";
import { ask, json } from "./claude";
import { emailTypeOf, hasField, httpUrl, salutationOf, validEmail } from "./lead-fields";

export const ENRICH_FIELDS: EnrichField[] = ["person", "role", "email", "phone", "linkedin", "website", "city"];
/* leads per request; the portal sends one at a time so the bar moves, the MCP or a script may send more */
export const ENRICH_MAX = 5;

type Lead = typeof leads.$inferSelect;
/* the lead columns a search may fill */
export type Filled = Partial<Record<"salutation" | "first" | "last" | "role" | "email" | "phone" | "linkedin" | "website" | "city", string>>;
export type EnrichResult = { id: number; found: Filled; missed: EnrichField[]; error?: string };

const s = () => z.string().nullish().transform(v => (v ?? "").trim());
const Found = z.object({ salutation: s(), first: s(), last: s(), role: s(), email: s(), phone: s(), linkedin: s(), website: s(), city: s(), sourceUrl: s() });

const LABEL: Record<EnrichField, string> = {
  person: "eine passende Ansprechperson (Geschäftsführung oder die für das Thema zuständige Person) mit Anrede, Vor- und Nachname und Funktion",
  role: "die Funktion der Person in der Firma (z. B. Geschäftsführer, Leiterin Einkauf)",
  email: "die geschäftliche E-Mail-Adresse der Person (persönliche Adresse vor info@-Postfach)",
  phone: "die geschäftliche Telefonnummer der Person (Durchwahl oder Mobil vor Zentrale), im Format +49 …",
  linkedin: "die Adresse des persönlichen LinkedIn-Profils der Person (linkedin.com/in/…), keine Firmenseite",
  website: "die offizielle Website der Firma (Startseite)",
  city: "den Ort des Firmensitzes",
};

async function search(ai: Ai, l: Lead, fields: EnrichField[]) {
  const person = [l.salutation, l.first, l.last].filter(Boolean).join(" ");
  const text = await ask({
    key: ai, effort: "low", web: true, maxSearches: 6 + fields.length,
    system: "Du recherchierst Kontaktdaten für den Vertrieb im Mittelstand. Nutze Firmenwebsite (Team, Kontakt, Impressum), Pressemitteilungen, Branchenverzeichnisse, Handelsregister und öffentliche Profile. Gib nur Angaben zurück, die du auf einer Quelle gesehen hast; erfinde nichts und leite keine Adresse aus einem Muster ab.",
    prompt: `Finde ${fields.map(f => LABEL[f]).join(", ")}.
Firma: ${l.company}${l.city ? `, ${l.city}` : ""}${l.website ? `, ${l.website}` : ""}
${person ? `Person: ${person}${l.role ? `, ${l.role}` : ""}` : fields.includes("person") ? "Noch keine Person bekannt: E-Mail, Telefon und LinkedIn gehören zu der Person, die du findest." : "Keine Person bekannt: nimm die allgemeinen Kontaktdaten der Firma."}
Antworte am Ende mit genau einem \`\`\`json-Block: {"salutation":"Herr oder Frau, mit Titel","first":"","last":"","role":"","email":"","phone":"","linkedin":"","website":"","city":"","sourceUrl":"Seite, auf der du die Angaben gefunden hast"}. Was du nicht findest oder nicht gesucht wurde, bleibt "".`,
  });
  return json(text, Found);
}

const cleanPhone = (p: string) => /\d{6,}/.test(p.replace(/[\s/().-]/g, "")) ? p.replace(/\s+/g, " ").slice(0, 40) : "";
const cleanLinkedin = (u: string) => { const h = httpUrl(u); return /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#\s]+/i.test(h) ? h.replace(/[?#].*$/, "").slice(0, 300) : ""; };
const cleanName = (n: string) => /^[\p{L}][\p{L}' .-]{0,60}$/u.test(n) ? n : "";
const cleanText = (t: string, max: number) => t.replace(/\s+/g, " ").slice(0, max);

/* Searches the web for the missing fields of each lead; nothing already there is overwritten, what it cannot find is remembered on the lead
   and skipped next time unless again is set, so a field that does not exist does not cost a search on every run */
export async function enrichContacts(tenantId: number, userId: number, ids: number[], fields: EnrichField[], again = false): Promise<EnrichResult[]> {
  const ai = await aiFor(tenantId, userId);
  if (!ai) throw new AiMissing();
  const rows = await db.select().from(leads).where(and(eq(leads.tenantId, tenantId), inArray(leads.id, ids.slice(0, ENRICH_MAX))));
  const out: EnrichResult[] = [];
  for (const l of rows) {
    const want = fields.filter(f => !hasField(l, f) && (again || !l.enrichMiss[f]));
    if (!want.length) { out.push({ id: l.id, found: {}, missed: [] }); continue; }
    let r;
    try { r = await search(ai, l, want); }
    catch (e) {
      const msg = (e as Error).message;
      await db.insert(runs).values({ tenantId, kind: "enrich", ok: false, info: `${l.company}: ${msg}`.slice(0, 500) });
      out.push({ id: l.id, found: {}, missed: [], error: msg }); continue;
    }
    const found: Filled = {}, got = new Set<EnrichField>();
    if (want.includes("person")) {
      const first = cleanName(r.first), last = cleanName(r.last);
      if (first && last) {
        Object.assign(found, { first, last, ...(salutationOf(r.salutation) ? { salutation: salutationOf(r.salutation) } : {}) });
        got.add("person");
        /* the role belongs to the person found */
        if (!l.role && cleanText(r.role, 120)) { found.role = cleanText(r.role, 120); got.add("role"); }
      }
    }
    const named = !!(l.first || l.last || found.last);
    if (want.includes("role") && named && !found.role && cleanText(r.role, 120)) { found.role = cleanText(r.role, 120); got.add("role"); }
    if (want.includes("email")) {
      const em = r.email.toLowerCase();
      /* an address another lead of this tenant already has would make a duplicate */
      const [dup] = validEmail(em) ? await db.select({ id: leads.id }).from(leads).where(and(eq(leads.tenantId, tenantId), ne(leads.id, l.id), sql`lower(${leads.email}) = ${em}`)).limit(1) : [];
      if (validEmail(em) && !dup) { found.email = em; got.add("email"); }
    }
    if (want.includes("phone") && cleanPhone(r.phone)) { found.phone = cleanPhone(r.phone); got.add("phone"); }
    if (want.includes("linkedin") && named && cleanLinkedin(r.linkedin)) { found.linkedin = cleanLinkedin(r.linkedin); got.add("linkedin"); }
    if (want.includes("website") && httpUrl(r.website)) { found.website = httpUrl(r.website).slice(0, 300); got.add("website"); }
    if (want.includes("city") && cleanText(r.city, 80)) { found.city = cleanText(r.city, 80); got.add("city"); }
    const missed = want.filter(f => !got.has(f));
    const miss = { ...l.enrichMiss };
    for (const f of want) if (got.has(f)) delete miss[f]; else miss[f] = new Date().toISOString();
    const email = found.email ?? l.email;
    await db.update(leads).set({
      ...found, enrichMiss: miss,
      ...(email && (found.email || found.last) ? { emailType: emailTypeOf(email, named) } : {}),
      ...(got.size && !l.sourceUrl && httpUrl(r.sourceUrl) ? { sourceUrl: httpUrl(r.sourceUrl) } : {}),
    }).where(eq(leads.id, l.id));
    out.push({ id: l.id, found, missed });
  }
  return out;
}
