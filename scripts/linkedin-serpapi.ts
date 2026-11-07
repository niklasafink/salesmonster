/* npx tsx scripts/linkedin-serpapi.ts <tenant-slug> [max searches, default 50] [--dry] [--again]
   Looks up the LinkedIn profile of leads that have a first and last name but no LinkedIn link: one Google search per lead through
   SerpAPI, five at a time. The query is site:linkedin.com/in "First Last" plus the distinctive word(s) of the company in their
   original spelling ("AUREN", not "auren wirtschaftspruefungsgesellschaft": generic words make Google drop every profile). For a
   sole practitioner ("Wirtschaftsprüfer Marc Tannhäuser") the company is the name itself, so the query takes "Wirtschaftsprüfer".
   Measured 2026-11-07 against ten other query forms (city, OR lists, no site:, Bing): this one found every profile that exists,
   extra words only made it worse. Whether a result counts is up to the check, not the query:
   - the title carries the name, and
   - title, snippet or URL carry the company, or the city plus a fitting role (Geschäftsführer, Partner, Wirtschaftsprüfer …),
     or, for a sole practitioner, the profession plus the city.
   Then leads.linkedin is set. Without a hit, enrichMiss.linkedin gets the date so the next run skips the lead (--again searches
   those too). Hits with the name but nothing else are printed for a look by hand and not written. Names that are no names
   ("Travel Manager", "G F") are skipped without a search. --dry lists leads and queries and spends nothing.
   Key: SERPAPI_KEY in .env.local (free plan: 250 searches a month). */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

const LEGAL = /\b(gmbh|mbh|ag|kg|ug|se|ohg|gbr|mbb|e\.?\s?v|eg|co|ltd|inc|llc|haftungsbeschränkt|und|&|der|die|das|für|von)\b/g;
const fold = (s: string) => s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  .normalize("NFD").replace(/[̀-ͯ]/g, "");
// Words that name the kind of company, not the company. In the query they make Google demand them on the profile page, which
// LinkedIn profiles rarely carry ("Wirtschaftsprüfungsgesellschaft"), so the search comes back without a single profile.
const GENERIC = /^(\w*gesellschaft|holding|gruppe|group|deutschland|germany|international|partner|partners|kanzlei|services?|solutions|wirtschaftspruefer|steuerberater|wirtschaftspruefung|steuerberatung|wpg|wp|stbg|stb|dr|prof|fuer|und|der|die|das|von)$/;
const coreWords = (company: string) => {
  const w = fold(company).replace(LEGAL, " ").split(/[^a-z0-9]+/).filter(x => x.length >= 3 && !GENERIC.test(x));
  return w.length ? w : [fold(company).trim()].filter(Boolean);
};
// Adjectives that start many company names and say little on their own.
const COMMON = /^(deutsche[rs]?|allgemeine|ostdeutscher|westdeutsche|norddeutsche|sueddeutsche|rheinische[rs]?|baden|neue|erste|treuhand)$/;
// The company words in their original spelling (Google handles umlauts itself, "pruefung" it does not).
const companyWords = (company: string) =>
  company.split(/[\s,()/+·]+/).map(x => x.replace(/[-.]+$/, "")).filter(x => { const f = fold(x).replace(/[^a-z0-9&]/g, ""); return f.length >= 2 && !f.match(new RegExp(`^(?:${LEGAL.source})$`)) && !GENERIC.test(f); });
// One word for the query: every further word narrows the search, and "Haydu" Pilgerrain finds the profile where
// "Haydu" Pilgerrain Vermögenstreuhand finds nothing. The first word that is not the person's own name and not a common adjective.
const queryWord = (company: string, name: string) => {
  const w = companyWords(company), own = new Set(tokens(name));
  const free = w.filter(x => !own.has(fold(x)));
  return free.find(x => x.length >= 3 && !COMMON.test(fold(x))) ?? free.find(x => !COMMON.test(fold(x))) ?? free[0] ?? "";
};
const profileUrl = (link: string) => {
  const m = link.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? `https://www.linkedin.com/in/${decodeURIComponent(m[1]).toLowerCase()}` : "";
};
const tokens = (s: string) => fold(s).split(/[^a-z0-9]+/).filter(x => x.length >= 2);
const NOT_A_NAME = /^(team|travel|manager|info|office|kontakt|vertrieb|einkauf|tender|sales|buero|zentrale|empfang|herr|frau)$/;
const ROLE = /wirtschaftspruef|steuerberat|audit|tax|partner|geschaeftsfuehr|managing director|ceo|inhaber|vorstand|director|leiter|head of/;
const PROFESSION = /wirtschaftspruef|steuerberat|audit|tax|pruefung/;

type Hit = { link: string; title?: string; snippet?: string };
type Lead = { id: number; first: string; last: string; company: string; city: string };

async function serp(key: string, q: string): Promise<Hit[]> {
  const u = new URL("https://serpapi.com/search.json");
  Object.entries({ engine: "google", q, google_domain: "google.de", gl: "de", hl: "de", num: "10", api_key: key }).forEach(([k, v]) => u.searchParams.set(k, v));
  const j = await (await fetch(u)).json() as { error?: string; organic_results?: Hit[] };
  if (j.error && !/hasn't returned any results/i.test(j.error)) throw new Error(`SerpAPI: ${j.error}`);
  return j.organic_results ?? [];
}

/* the name as it goes into the query: the first given name only (profiles rarely show "Christoph Albin Robert"), initials
   dropped, a last name typed twice ("Schlösser Schlösser") once */
function cleanName(l: Lead) {
  const last = [...new Set(l.last.split(/\s+/).filter(w => w.replace(/\./g, "").length >= 2))].join(" ");
  const first = l.first.split(/\s+/).filter(w => w.replace(/\./g, "").length >= 2)[0] ?? "";
  const ok = first.length >= 2 && last.length >= 2 && ![...tokens(first), ...tokens(last)].some(w => NOT_A_NAME.test(w));
  // middle names often sit in the last name field ("Martin" "Christian Schliemann"): then first and final name each on their own
  const parts = last.split(/\s+/), phrase = parts.length > 1 ? `"${first}" "${parts.at(-1)}"` : `"${first} ${last}"`;
  return { first, last: parts.length > 1 ? parts.at(-1)! : last, phrase, ok };
}
/* a sole practitioner: apart from generic words the company is just the person's name ("Wirtschaftsprüfer Marc Tannhäuser",
   "WP Koehler GmbH"), so it says nothing a profile would repeat; "Bert & Daiber" names a second person and stays a firm */
const isSolo = (l: Lead) => { const name = new Set(tokens(`${l.first} ${l.last}`)); return coreWords(l.company).every(w => name.has(w)) || !queryWord(l.company, `${l.first} ${l.last}`); };
/* an audit or tax firm: there a profile that names the profession counts even without the firm (Lutz Schöcker, "Wirtschaftsprüfer",
   at ABRT, which his profile does not name) */
const isAuditFirm = (company: string) => /wirtschaftspr|steuerber|audit|revision|pruefungs|treuhand|\bwpg\b|\bstbg\b/.test(fold(company));
const query = (l: Lead) => { const n = cleanName(l); return `site:linkedin.com/in ${n.phrase} ${isSolo(l) ? "Wirtschaftsprüfer" : queryWord(l.company, `${l.first} ${l.last}`)}`; };

/* the best result for a lead: sure (write it), unsure (name only, print it) or nothing */
function judge(l: Lead, hits: Hit[]) {
  const n = cleanName(l), need = tokens(`${n.first} ${n.last}`), solo = isSolo(l);
  const words = coreWords(l.company), city = tokens(l.city)[0];
  const named = hits.filter(h => { const have = new Set(tokens(h.title ?? "")); return profileUrl(h.link) && need.every(w => have.has(w)); });
  const sure = named.find(h => {
    const text = fold(`${h.title} ${h.snippet} ${decodeURIComponent(h.link)}`), inCity = !!city && text.includes(city);
    if (solo) return PROFESSION.test(text) && (inCity || !city);
    return words.some(w => text.includes(w)) || (inCity && ROLE.test(text)) || (isAuditFirm(l.company) && PROFESSION.test(fold(`${h.title} ${h.snippet}`)));
  });
  return { sure, unsure: sure ? undefined : named[0] };
}

async function main() {
  const args = process.argv.slice(2), flags = new Set(args.filter(a => a.startsWith("--"))), [slug, max = "50"] = args.filter(a => !a.startsWith("--"));
  const key = process.env.SERPAPI_KEY;
  if (!slug) throw new Error("Aufruf: npx tsx scripts/linkedin-serpapi.ts <mandant> [max] [--dry] [--again]");
  if (!key) throw new Error("SERPAPI_KEY fehlt in .env.local");
  const { and, eq, ne, notInArray, desc, sql } = await import("drizzle-orm");
  const { db, tenants, leads } = await import("../src/db");
  const [t] = await db.select().from(tenants).where(eq(tenants.slug, slug));
  if (!t) throw new Error("Mandant nicht gefunden");

  const all: Lead[] = await db.select({ id: leads.id, first: leads.first, last: leads.last, company: leads.company, city: leads.city }).from(leads)
    .where(and(eq(leads.tenantId, t.id), eq(leads.linkedin, ""), ne(leads.first, ""), ne(leads.last, ""), notInArray(leads.status, ["papierkorb", "dublette"]),
      flags.has("--again") ? undefined : sql`not (${leads.enrichMiss} ? 'linkedin')`))
    .orderBy(sql`${leads.rating} desc nulls last`, desc(leads.createdAt));
  const skipped = all.filter(l => !cleanName(l).ok), list = all.filter(l => cleanName(l).ok);
  const acc = await (await fetch(`https://serpapi.com/account.json?api_key=${key}`)).json() as { total_searches_left?: number; error?: string };
  if (acc.error) throw new Error(`SerpAPI: ${acc.error}`);
  const left = acc.total_searches_left ?? 0, n = Math.min(list.length, Number(max), left);
  console.log(`${t.slug}: ${list.length} Leads ohne LinkedIn (${skipped.length} ohne brauchbaren Namen übersprungen), ${left} Suchen frei, jetzt ${n}${flags.has("--dry") ? " (Probelauf, keine Suche)" : ""}`);
  if (flags.has("--dry")) { list.slice(0, n).forEach(l => console.log(`  ${l.first} ${l.last} · ${l.company}  →  ${query(l)}`)); return; }

  let found = 0, miss = 0;
  const unsure: string[] = [], todo = list.slice(0, n), t0 = Date.now();
  const work = async (l: Lead) => {
    const { sure, unsure: maybe } = judge(l, await serp(key, query(l)));
    if (sure) {
      await db.update(leads).set({ linkedin: profileUrl(sure.link) }).where(eq(leads.id, l.id));
      found++; console.log(`✓ ${l.first} ${l.last} · ${l.company} → ${profileUrl(sure.link)}`);
    } else {
      await db.update(leads).set({ enrichMiss: sql`${leads.enrichMiss} || jsonb_build_object('linkedin', ${new Date().toISOString()}::text)` }).where(eq(leads.id, l.id));
      miss++;
      if (maybe) unsure.push(`${l.first} ${l.last} · ${l.company} → ${profileUrl(maybe.link)} (${maybe.title} | ${(maybe.snippet ?? "").slice(0, 100)})`);
      console.log(`– ${l.first} ${l.last} · ${l.company}${maybe ? " (Name gefunden, sonst nichts)" : ""}`);
    }
  };
  // five searches at a time: SerpAPI answers in about a second, now and then in ten
  const queue = [...todo];
  await Promise.all(Array.from({ length: 5 }, async () => { for (let l = queue.shift(); l; l = queue.shift()) await work(l); }));
  console.log(`\nGefunden ${found}, nicht gefunden ${miss}, Suchen verbraucht ${n}, ${Math.round((Date.now() - t0) / 1000)} s`);
  if (unsure.length) console.log(`\nVon Hand prüfen (nicht eingetragen):\n${unsure.map(u => `  ${u}`).join("\n")}`);
}
main().then(() => process.exit(0), e => { console.error(e.message); process.exit(1); });
