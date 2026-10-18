import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, leads, runs, type EnrichField } from "@/db";
import { AiMissing, aiFor, type Ai } from "./ai";
import { ask, json } from "./claude";
import { emailTypeOf, httpUrl, validEmail } from "./lead-fields";

export const ENRICH_FIELDS: EnrichField[] = ["email", "phone"];
/* leads per request; the portal sends one at a time so the bar moves, the MCP or a script may send more */
export const ENRICH_MAX = 5;

type Lead = typeof leads.$inferSelect;
export type EnrichResult = { id: number; found: Partial<Record<EnrichField, string>>; missed: EnrichField[]; error?: string };

const s = () => z.string().nullish().transform(v => (v ?? "").trim());
const Found = z.object({ email: s(), phone: s(), sourceUrl: s() });

const LABEL: Record<EnrichField, string> = {
  email: "die geschäftliche E-Mail-Adresse der Person (persönliche Adresse vor info@-Postfach)",
  phone: "die geschäftliche Telefonnummer der Person (Durchwahl oder Mobil vor Zentrale), im Format +49 …",
};

async function search(ai: Ai, l: Lead, fields: EnrichField[]) {
  const person = [l.salutation, l.first, l.last].filter(Boolean).join(" ");
  const text = await ask({
    key: ai, effort: "low", web: true, maxSearches: 6,
    system: "Du recherchierst Kontaktdaten für den Vertrieb im Mittelstand. Nutze Firmenwebsite (Team, Kontakt, Impressum), Pressemitteilungen, Branchenverzeichnisse und öffentliche Profile. Gib nur Angaben zurück, die du auf einer Quelle gesehen hast; erfinde nichts und leite keine Adresse aus einem Muster ab.",
    prompt: `Finde ${fields.map(f => LABEL[f]).join(" und ")}.
Firma: ${l.company}${l.city ? `, ${l.city}` : ""}${l.website ? `, ${l.website}` : ""}
${person ? `Person: ${person}${l.role ? `, ${l.role}` : ""}` : "Keine Person bekannt: nimm die allgemeinen Kontaktdaten der Firma."}
Antworte am Ende mit genau einem \`\`\`json-Block: {"email":"","phone":"","sourceUrl":"Seite, auf der du die Angabe gefunden hast"}. Was du nicht findest, bleibt "".`,
  });
  return json(text, Found);
}

const cleanPhone = (p: string) => /\d{6,}/.test(p.replace(/[\s/().-]/g, "")) ? p.replace(/\s+/g, " ").slice(0, 40) : "";

/* Searches the web for the missing fields of each lead; what it cannot find is remembered on the lead */
export async function enrichContacts(tenantId: number, userId: number, ids: number[], fields: EnrichField[]): Promise<EnrichResult[]> {
  const ai = await aiFor(tenantId, userId);
  if (!ai) throw new AiMissing();
  const rows = await db.select().from(leads).where(and(eq(leads.tenantId, tenantId), inArray(leads.id, ids.slice(0, ENRICH_MAX))));
  const out: EnrichResult[] = [];
  for (const l of rows) {
    const want = fields.filter(f => !l[f]);
    if (!want.length) { out.push({ id: l.id, found: {}, missed: [] }); continue; }
    let r;
    try { r = await search(ai, l, want); }
    catch (e) {
      const msg = (e as Error).message;
      await db.insert(runs).values({ tenantId, kind: "enrich", ok: false, info: `${l.company}: ${msg}`.slice(0, 500) });
      out.push({ id: l.id, found: {}, missed: [], error: msg }); continue;
    }
    const found: Partial<Record<EnrichField, string>> = {};
    if (want.includes("email")) {
      const em = r.email.toLowerCase();
      /* an address another lead of this tenant already has would make a duplicate */
      const [dup] = validEmail(em) ? await db.select({ id: leads.id }).from(leads).where(and(eq(leads.tenantId, tenantId), ne(leads.id, l.id), sql`lower(${leads.email}) = ${em}`)).limit(1) : [];
      if (validEmail(em) && !dup) found.email = em;
    }
    if (want.includes("phone") && cleanPhone(r.phone)) found.phone = cleanPhone(r.phone);
    const missed = want.filter(f => !found[f]);
    const miss = { ...l.enrichMiss };
    for (const f of want) if (found[f]) delete miss[f]; else miss[f] = new Date().toISOString();
    await db.update(leads).set({
      ...found, enrichMiss: miss,
      ...(found.email ? { emailType: emailTypeOf(found.email, !!(l.first || l.last)) } : {}),
      ...(Object.keys(found).length && !l.sourceUrl && httpUrl(r.sourceUrl) ? { sourceUrl: httpUrl(r.sourceUrl) } : {}),
    }).where(eq(leads.id, l.id));
    out.push({ id: l.id, found, missed });
  }
  return out;
}
