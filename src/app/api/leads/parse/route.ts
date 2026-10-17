import { eq } from "drizzle-orm";
import { db, leads } from "@/db";
import { HttpError, route, tenantBySlug } from "@/lib/api";
import { parseImport } from "@/lib/claude";
import { getInteg } from "@/lib/integrations";
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
  const key = (await getInteg(t.id, "claude"))?.key;
  const rows = key ? await parseImport(key, text) : regexParse(text);
  const have = new Set((await db.select({ c: leads.company }).from(leads).where(eq(leads.tenantId, t.id))).map(r => norm(r.c)));
  const hub = await hubspotToken(t.id);
  const out = await Promise.all(rows.map(async r => {
    let dup = have.has(norm(r.co)) ? "Schon in der Liste" : "";
    if (!dup && hub) dup = (await hubspotKnown(hub, r.co, r.web, r.email).catch(() => null)) ? "In HubSpot" : "";
    return { ...r, dup };
  }));
  return { rows: out };
});
