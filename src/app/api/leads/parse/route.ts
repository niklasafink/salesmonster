import { eq } from "drizzle-orm";
import { db, leads } from "@/db";
import { HttpError, route, tenantBySlug } from "@/lib/api";
import { parseImport } from "@/lib/claude";
import { aiFor } from "@/lib/ai";
import { hubspotKnown, hubspotToken } from "@/lib/hubspot";
import { norm } from "@/lib/outreach";

export const maxDuration = 120;

/* Fallback when Claude is not connected: the pattern parser from the wireframe */
function regexParse(txt: string) {
  const coRe = /([A-ZÄÖÜ][\wÄÖÜäöüß&.\- ]*?\b(?:GmbH & Co\. KG|GmbH|AG|KG|SE|e\.K\.|UG))/;
  const pRe = /(?:GF|Geschäftsführer(?:in)?|Inhaber(?:in)?|Ansprechpartner(?:in)?)[:\s]+([A-ZÄÖÜ][a-zäöüß]+ [A-ZÄÖÜ][a-zäöüß]+)/;
  const roleOf = (s: string) => /GF|Geschäftsführ/.test(s) ? "Geschäftsführung" : /Inhaber/.test(s) ? "Inhaber" : /Ansprech/.test(s) ? "Ansprechpartner" : "";
  return txt.split(/\n/).map(line => {
    const c = line.match(coRe); if (!c) return null;
    const co = c[1].split(/\s[-–]\s/).pop()!.trim(), pm = line.match(pRe), em = line.match(/[\w.+-]+@[\w-]+\.[\w.]+/), web = line.match(/www\.[\w.-]+/);
    return { co, p: pm ? pm[1] : "", role: pm ? roleOf(pm[0]) : "", email: em ? em[0] : "", web: web ? web[0] : "", city: "" };
  }).filter((x): x is NonNullable<typeof x> => !!x);
}

export const POST = route(async (req, _c, me) => {
  const { t: slug, text } = await req.json();
  const t = await tenantBySlug(slug, me);
  if (!String(text || "").trim()) throw new HttpError(400, "Keine Daten");
  const key = await aiFor(t.id, me.id);
  const rows = key ? await parseImport(key, text) : regexParse(text);
  /* One person per company gets the mail; further people at that company are kept as contacts.
     Only rows that add nothing new (same address, or a known company without an address) are dropped. */
  const prev = await db.select({ c: leads.company, e: leads.email }).from(leads).where(eq(leads.tenantId, t.id));
  const companies = new Set(prev.map(r => norm(r.c))), emails = new Set(prev.map(r => r.e.toLowerCase()).filter(Boolean));
  const hub = await hubspotToken(t.id);
  const inHub = await Promise.all(rows.map(r => hub ? hubspotKnown(hub, r.co, r.web, r.email).catch(() => null) : null));
  const out = rows.map((r, i) => {
    const email = (r.email || "").toLowerCase(), known = companies.has(norm(r.co)) || !!inHub[i];
    const dup = email && emails.has(email) ? "Schon in der Liste" : inHub[i]?.why === "Kontakt in HubSpot" ? "Kontakt in HubSpot" : known && !email ? "Firma bekannt" : "";
    const extra = !dup && known ? "Weiterer Kontakt" : "";
    companies.add(norm(r.co)); if (email) emails.add(email);
    return { ...r, dup, extra };
  });
  return { rows: out };
});
