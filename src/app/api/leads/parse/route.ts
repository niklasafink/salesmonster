import { eq } from "drizzle-orm";
import { db, leads } from "@/db";
import { HttpError, route, tenantBySlug } from "@/lib/api";
import { parseImport } from "@/lib/claude";
import { aiFor } from "@/lib/ai";
import { hubspotKnown, hubspotToken } from "@/lib/hubspot";
import { norm } from "@/lib/outreach";
import { getInteg } from "@/lib/integrations";
import { guessSalutations } from "@/lib/jev";

export const maxDuration = 120;

/* "Frau Dr." style salutation for {{anrede}}, or "" when neither Herr nor Frau is known */
function salutationOf(raw: string) {
  const g = /\bfrau\b/i.test(raw) ? "Frau" : /\bherr\b/i.test(raw) ? "Herr" : "";
  if (!g) return "";
  return [g, /prof/i.test(raw) && "Prof.", /\bdr\b/i.test(raw) && "Dr."].filter(Boolean).join(" ");
}

/* Fallback when Claude is not connected: the pattern parser from the wireframe */
function regexParse(txt: string) {
  const coRe = /([A-ZÄÖÜ][\wÄÖÜäöüß&.\- ]*?\b(?:GmbH & Co\. KG|GmbH|AG|KG|SE|e\.K\.|UG))/;
  const pRe = /(?:GF|Geschäftsführer(?:in)?|Inhaber(?:in)?|Ansprechpartner(?:in)?)[:\s]+((?:(?:Herr|Frau|Prof\.|Dr\.)\s+)*)([A-ZÄÖÜ][a-zäöüß]+ [A-ZÄÖÜ][a-zäöüß]+)/;
  const roleOf = (s: string) => /GF|Geschäftsführ/.test(s) ? "Geschäftsführung" : /Inhaber/.test(s) ? "Inhaber" : /Ansprech/.test(s) ? "Ansprechpartner" : "";
  return txt.split(/\n/).map(line => {
    const c = line.match(coRe); if (!c) return null;
    const co = c[1].split(/\s[-–]\s/).pop()!.trim(), pm = line.match(pRe), em = line.match(/[\w.+-]+@[\w-]+\.[\w.]+/), web = line.match(/www\.[\w.-]+/);
    return { co, sal: pm ? pm[1] : "", p: pm ? pm[2] : "", role: pm ? roleOf(pm[0]) : "", email: em ? em[0] : "", web: web ? web[0] : "", city: "", li: "", hook: "" };
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
    return { ...r, sal: salutationOf(r.sal), dup, extra };
  });
  /* No Herr/Frau in the source: Jev guesses from name and role, a title found in the text is kept */
  const open = out.map((r, i) => i).filter(i => out[i].p && !out[i].sal);
  const jev = open.length ? await getInteg(t.id, "jev") : null;
  if (jev) {
    const g = await guessSalutations(jev.key || "", open.map(i => { const [first, ...rest] = out[i].p.trim().split(/\s+/); return { first, last: rest.join(" "), role: out[i].role }; })).catch(() => []);
    open.forEach((i, k) => { if (g[k]) out[i].sal = salutationOf(`${g[k]} ${rows[i].sal}`); });
  }
  return { rows: out };
});
