import { HttpError, route, tenantBySlug } from "@/lib/api";
import { parseImport } from "@/lib/claude";
import { aiFor } from "@/lib/ai";
import { checkLeads } from "@/lib/lead-import";

export const maxDuration = 120;

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
  return { rows: await checkLeads(t.id, rows) };
});
