import { HttpError, route, tenantBySlug } from "@/lib/api";
import { IMPORT_CHARS, parseImport } from "@/lib/claude";
import { aiFor } from "@/lib/ai";
import { FIELDS, applyMap, headFields, splitTable, type Field } from "@/lib/lead-columns";
import { checkLeads } from "@/lib/lead-import";
import { pool } from "@/lib/outreach";
import { MAX_ROWS, tsvChunks } from "@/lib/sheet";
import { track } from "@/lib/usage";

/* A 1,000-row sheet is 9 AI calls, 3 at a time */
export const maxDuration = 300;

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

/* Pasted tables without AI: columns by header name, needs a company column and one more */
function tableParse(txt: string) {
  const t = splitTable(txt), map = t && headFields(t.head);
  if (!t || !map?.includes("co") || map.filter(Boolean).length < 2) return null;
  return applyMap(t, map);
}

export const POST = route(async (req, _c, me) => {
  const { t: slug, text, map } = await req.json();
  const t = await tenantBySlug(slug, me);
  if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "Keine Daten");
  /* the user reviewed the column mapping: no AI needed, ignored columns stay out */
  if (Array.isArray(map)) {
    const table = splitTable(text);
    if (!table || map.length !== table.head.length || map.some(f => typeof f !== "string" || (f && !Object.hasOwn(FIELDS, f)))) throw new HttpError(400, "Zuordnung passt nicht zur Tabelle");
    if (!map.includes("co")) throw new HttpError(400, "Keine Spalte für die Firma");
    if (table.rows.length > MAX_ROWS) throw new HttpError(400, "Mehr als 1.000 Datenzeilen");
    return { rows: await checkLeads(t.id, applyMap(table, map as Field[])) };
  }
  const key = await aiFor(t.id, me.id);
  if (!key) return { rows: await checkLeads(t.id, tableParse(text) ?? regexParse(text)) };
  const parts = tsvChunks(text, 120), table = parts.length > 1;
  if (table && parts.reduce((n, p) => n + p.split("\n").length - 1, 0) > MAX_ROWS) throw new HttpError(400, "Mehr als 1.000 Datenzeilen");
  if (parts.some(p => p.length > IMPORT_CHARS))
    throw new HttpError(400, table ? "Zeilen zu lang: höchstens 40.000 Zeichen je 120 Zeilen" : "Text zu lang: höchstens 40.000 Zeichen, bitte in Teilen importieren");
  const rows = await track({ tenantId: t.id, userId: me.id, kind: "import" }, async m => {
    const rs = (await pool(parts, 3, p => parseImport(key, p))).flat();
    m.count(rs.length);
    return rs;
  });
  return { rows: await checkLeads(t.id, rows) };
});
