import { HttpError, route, tenantBySlug } from "@/lib/api";
import { IMPORT_CHARS, parseImport } from "@/lib/claude";
import { aiFor } from "@/lib/ai";
import { checkLeads } from "@/lib/lead-import";
import { pool } from "@/lib/outreach";
import { MAX_ROWS, tsvChunks } from "@/lib/sheet";

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

/* Pasted tables (Excel, CSV): column headers, lowercased and without spaces, dashes and dots */
const HEAD: [string, RegExp][] = [
  ["co", /^(firma|firmenname|unternehmen|company|companyname|organisation|organization|account|accountname|kunde)$/],
  ["sal", /^(anrede|salutation|titel|prefix)$/],
  ["first", /^(vorname|firstname|first|givenname)$/],
  ["last", /^(nachname|lastname|last|surname|familyname|familienname)$/],
  ["name", /^(name|fullname|kontakt|kontaktperson|ansprechpartner(in)?|contact|contactname|contactperson|person)$/],
  ["role", /^(rolle|position|funktion|role|jobtitle|title|job)$/],
  ["email", /^(e?mail|emailadresse|mailadresse|emailaddress)$/],
  ["web", /^(website|webseite|homepage|internet|url|web|domain)$/],
  ["city", /^(ort|stadt|city|standort|location|town)$/],
  ["li", /^(linkedin|linkedinurl|linkedinprofil|linkedinprofile)$/],
];

const cells = (line: string, sep: string) => {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += ch; i++; } else q = !q; }
    else if (ch === sep && !q) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  return [...out, cur.trim()];
};

/* A header row naming at least the company and one more known column; null when the text is no such table */
function tableParse(txt: string) {
  const lines = txt.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return null;
  for (const sep of ["\t", ";", ","]) {
    const col: Record<string, number> = {};
    cells(lines[0], sep).forEach((h, i) => {
      const k = HEAD.find(([, re]) => re.test(h.toLowerCase().replace(/[\s_.\-:/()]/g, "")))?.[0];
      if (k && !(k in col)) col[k] = i;
    });
    if (!("co" in col) || Object.keys(col).length < 2) continue;
    /* "Name" next to "Vorname" is the family name */
    if ("first" in col && "name" in col && !("last" in col)) { col.last = col.name; delete col.name; }
    return lines.slice(1).map(line => {
      const c = cells(line, sep), v = (k: string) => k in col ? c[col[k]] || "" : "";
      /* "Herr Dr. Max Muster" in one cell: the title goes to the salutation */
      const [, t, p] = (v("name") || [v("first"), v("last")].filter(Boolean).join(" ")).match(/^((?:(?:Herr|Frau|Prof\.|Dr\.)\s+)*)(.*)$/)!;
      return { co: v("co"), sal: v("sal") || t.trim(), p, role: v("role"), email: v("email"), web: v("web"), city: v("city"), li: v("li"), hook: "" };
    }).filter(r => r.co);
  }
  return null;
}

export const POST = route(async (req, _c, me) => {
  const { t: slug, text } = await req.json();
  const t = await tenantBySlug(slug, me);
  if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "Keine Daten");
  const key = await aiFor(t.id, me.id);
  if (!key) return { rows: await checkLeads(t.id, tableParse(text) ?? regexParse(text)) };
  const parts = tsvChunks(text, 120), table = parts.length > 1;
  if (table && parts.reduce((n, p) => n + p.split("\n").length - 1, 0) > MAX_ROWS) throw new HttpError(400, "Mehr als 1.000 Datenzeilen");
  if (parts.some(p => p.length > IMPORT_CHARS))
    throw new HttpError(400, table ? "Zeilen zu lang: höchstens 40.000 Zeichen je 120 Zeilen" : "Text zu lang: höchstens 40.000 Zeichen, bitte in Teilen importieren");
  const rows = (await pool(parts, 3, p => parseImport(key, p))).flat();
  return { rows: await checkLeads(t.id, rows) };
});
