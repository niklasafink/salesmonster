/* Column mapping for pasted or uploaded lead tables. Pure, so the import dialog can use it too. */

/* CRM fields a column can feed, named as in the contact record; "" = ignore the column */
export const FIELDS = {
  co: "Firma",
  sal: "Anrede",
  first: "Vorname",
  last: "Nachname",
  name: "Vor- und Nachname",
  role: "Rolle",
  email: "E-Mail",
  phone: "Telefon",
  li: "LinkedIn",
  web: "Website",
  city: "Ort",
  hook: "Anlass",
  url: "Link zur Quelle",
  note: "Notiz",
} as const;
export type Field = keyof typeof FIELDS | "";
export type Column = { head: string; samples: string[]; field: Field };

/* Column headers, lowercased and without spaces, dashes and dots */
const HEAD: [Field, RegExp][] = [
  ["co", /^(firma|firmenname|unternehmen|company|companyname|organisation|organization|account|accountname|kunde)$/],
  ["sal", /^(anrede|salutation|titel|prefix)$/],
  ["first", /^(vorname|firstname|first|givenname)$/],
  ["last", /^(nachname|lastname|last|surname|familyname|familienname)$/],
  ["name", /^(name|fullname|kontakt|kontaktperson|ansprechpartner(in)?|contact|contactname|contactperson|person)$/],
  ["role", /^(rolle|position|funktion|role|jobtitle|title|job)$/],
  ["email", /^(e?mail|emailadresse|mailadresse|emailaddress)$/],
  ["phone", /^(tel|telefon|telefonnummer|phone|phonenumber|telephone|rufnummer|mobil|mobile|mobilnummer|handy|handynummer|durchwahl|festnetz)$/],
  ["web", /^(website|webseite|homepage|internet|url|web|domain)$/],
  ["city", /^(ort|stadt|city|standort|location|town)$/],
  ["li", /^(linkedin|linkedinurl|linkedinprofil|linkedinprofile)$/],
  ["url", /^(quelle|quellen|quellurl|quelllink|linkzurquelle|source|sourceurl|fundstelle|profil|profilseite|profilurl)$/],
  ["note", /^(notiz|notizen|bemerkung|bemerkungen|kommentar|note|notes|bereich|abteilung|department|zuständigkeit.*|schwerpunkt)$/],
];
/* "Titel (wörtlich)" is read as "Titel" */
const headField = (h: string): Field => HEAD.find(([, re]) => re.test(h.toLowerCase().replace(/\(.*?\)/g, "").replace(/[\s_.\-:/()]/g, "")))?.[0] ?? "";
/* Fields by header name alone; "Name" next to "Vorname" is the family name */
export function headFields(head: string[]): Field[] {
  const f = head.map(headField);
  if (f.includes("first") && !f.includes("last")) { const i = f.indexOf("name"); if (i >= 0) f[i] = "last"; }
  return f;
}

/* A quote only opens a quoted cell at its start (CSV); „Partner" inside a cell is text and must not swallow the separators after it */
const cells = (line: string, sep: string) => {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch !== '"') cur += ch; else if (line[i + 1] === '"') { cur += ch; i++; } else q = false; }
    else if (ch === '"' && !cur.trim()) { q = true; cur = ""; }
    else if (ch === sep) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  return [...out, cur.trim()];
};

/* Header row plus data rows, or null when the text is free text. Tabs (Excel, uploaded files) always count;
   ; and , only with at least one known header, so "Muster GmbH, Berlin" stays text. */
export function splitTable(txt: string): { head: string[]; rows: string[][] } | null {
  const lines = txt.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return null;
  for (const sep of ["\t", ";", ","]) {
    const head = cells(lines[0], sep);
    if (head.length < 2 || (sep !== "\t" && !headFields(head).some(Boolean))) continue;
    const rows = lines.slice(1).map(l => cells(l, sep));
    if (rows.filter(r => r.length > 1).length < rows.length / 2) continue;
    return { head, rows };
  }
  return null;
}

/* A cell as it goes into the CRM: no wrapping quotes, no placeholder dash, a Markdown link becomes its text */
export function clean(raw: string) {
  let s = (raw || "").trim().replace(/\[([^\]]*)\]\((\S+?)\)/g, "$1").trim();
  while (/^["'„“”‚‘’»«]/.test(s) && /["'„“”‘’»«]$/.test(s) && s.length > 1) s = s.slice(1, -1).trim();
  return /^[-–—/]$|^(n\/?a|k\.?\s?a\.?)$/i.test(s) ? "" : s;
}
/* For link fields: the target of a Markdown link, else the cleaned cell */
const link = (raw: string) => (raw || "").match(/\]\((https?:\/\/\S+?)\)/)?.[1] || clean(raw);
/* Research lists say "nicht veröffentlicht", "kein Treffer", "nur Kontaktformular" where a value is missing */
const MISSING = /^(nicht|kein|keine|nur|unbekannt|offen)\b/i;
/* "+49 30 203015 0 (Standort)", "02102/1669-123, Mobil 0172/5237752": only the numbers */
const PHONE = /\+?\(?\d[\d\s()\/.\-–]{4,}\d/g;
const phones = (s: string) => (s.match(PHONE) || []).map(n => n.replace(/\s+/g, " ").trim()).filter(n => n.replace(/\D/g, "").length >= 5);
function cellOf(raw: string, f: Field) {
  if (f === "web" || f === "url" || f === "li") return link(raw);
  const s = clean(raw);
  if (f === "note" || f === "hook" || f === "co") return s;
  if (MISSING.test(s)) return "";
  /* "wp-berlin@etl.de (Sammeladresse)": the address; text without one is no address */
  if (f === "email") return s.match(/[^\s@:;,<>()]+@[^\s@:;,<>()]+\.[a-z]{2,}/gi)?.join("; ") || (s.includes("@") ? s : "");
  if (f === "phone") return phones(s).join(" / ");
  /* „Partner" (im Interview: „Partner für Audit Innovation") */
  if (f === "role") return s.replace(/[„“”"]/g, "").replace(/\s+/g, " ").trim();
  /* "Pforzheim (Vorwahl)" */
  if (f === "city") return s.replace(/\s*\(.*\)\s*$/, "");
  return s;
}

/* Do the values fit the field? Header names and Jev both misjudge, e.g. "Standort" holding dates or notes. */
const URL_RE = /^(https?:\/\/|www\.)\S+$|^[\w-]+(\.[\w-]+)+(\/\S*)?$/i;
const FITS: Partial<Record<Field, (v: string) => boolean>> = {
  co: v => v.length <= 100,
  sal: v => v.length <= 30 && /^(herr|frau|hr|fr|mr|mrs|ms|dr|prof|divers)\b/i.test(v),
  first: v => v.length <= 40 && !/[\d@]/.test(v),
  last: v => v.length <= 40 && !/[\d@]/.test(v),
  name: v => v.length <= 60 && !/[\d@;]/.test(v),
  /* codes like "A", "R1" or "R1 (schwach)" are no role and stay out */
  role: v => v.length <= 160 && !/@/.test(v) && !/^[A-Z]{0,2}\d{0,2}(\s*[(/?]|$)/i.test(v),
  note: v => !/^[A-Z]{0,2}\d{0,2}$/i.test(v),
  email: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  /* one or several numbers, e.g. "+49 69 967 65 1141 / +49 152 01 234567" */
  phone: v => v.length <= 120 && v.replace(/\D/g, "").length >= 5,
  web: v => URL_RE.test(v) && !/@/.test(v),
  url: v => URL_RE.test(v),
  li: v => /linkedin\./i.test(v),
  city: v => v.length <= 40 && !/[\d;:@]/.test(v),
};
export function fits(f: Field, samples: string[]) {
  const ok = f && FITS[f], vals = samples.map(s => cellOf(s, f)).filter(Boolean);
  return !ok || !vals.length || vals.filter(ok).length * 2 > vals.length;
}

/* Up to 5 distinct non-empty values per column, for Jev and for the review step */
export function columnsOf(t: { head: string[]; rows: string[][] }): Column[] {
  const f = headFields(t.head);
  return t.head.map((head, i) => {
    const seen = new Set<string>();
    for (const r of t.rows) { const v = (r[i] || "").trim().slice(0, 120); if (clean(v)) seen.add(v); if (seen.size === 5) break; }
    const samples = [...seen];
    /* "Titel" holding job titles rather than Herr/Dr. is the role */
    const field = fits(f[i], samples) ? f[i] : f[i] === "sal" && fits("role", samples) ? "role" : "";
    return { head, samples, field };
  });
}

export type MappedRow = { co: string; sal: string; p: string; role: string; email: string; phone: string; web: string; city: string; li: string; hook: string; url: string; note: string };

/* Values of several people in one cell: "Max Muster / Ida Bau", "a@x.de; b@x.de", one per line */
const SEP = /\s+\/\s+|\s*[;|\n]\s*|\s+(?:und|&)\s+/;
function parts(x: string, f: Field) {
  const p = x.split(f === "email" ? new RegExp(`${SEP.source}|\\s*,\\s*`) : SEP).map(s => s.trim()).filter(Boolean);
  /* "069 / 96765" is one number with area code, only full numbers count as several */
  if (f === "phone" && p.some(n => n.replace(/\D/g, "").length < 6)) return [x];
  return p;
}

/* Applies the reviewed mapping; columns set to "" are ignored, rows without a company are dropped.
   One person: several columns on one field, the first non-empty cell wins (e.g. "E-Mail 1", "E-Mail 2"); phone numbers are all kept.
   Several people, as several name columns ("Ansprechpartner A", "Ansprechpartner B") or several names in one cell:
   each becomes a contact of the company, and person cells with as many values as people are spread in order,
   so "+49 69 … / +49 152 …" next to two names gives each person their number. A single value stays with the first person, a phone number goes to all.
   Columns on Notiz are collected as "Spalte: Wert", so side facts sit in one short text instead of fields of their own. */
export function applyMap(t: { head: string[]; rows: string[][] }, map: Field[]): MappedRow[] {
  return t.rows.flatMap(c => {
    /* a cell that does not fit its field (a code as role, a date as city) is left out, the rest of the row stays;
       a broken address goes on, so the review can flag it */
    const cell = (i: number, f: Field) => { const x = cellOf(c[i] || "", f); return f === "co" || f === "email" || !FITS[f] || FITS[f]!(x) ? x : ""; };
    const v = (f: Field) => map.reduce<string>((acc, m, i) => acc || (m === f ? cell(i, f) : ""), "");
    const all = (f: Field) => map.flatMap((m, i) => m === f && cell(i, f) ? [cell(i, f)] : []);
    /* person values in column order, each cell split into the people it names */
    const vals = (f: Field) => all(f).flatMap(x => parts(x, f));
    const names = vals("name"), firsts = vals("first"), lasts = vals("last");
    const n = Math.max(names.length, firsts.length, lasts.length, 1);
    const pick = (f: Field, k: number) => {
      const xs = vals(f);
      if (n > 1 && xs.length === n) return xs[k];
      if (f === "phone") return !k || xs.length === 1 ? [...new Set(all(f))].join(" / ") : "";
      /* "a@x.de; b@x.de" for one person: the first address */
      return k ? "" : f === "email" ? xs[0] || "" : v(f);
    };
    const note = map.map((m, i) => m === "note" && cell(i, m) ? `${t.head[i]}: ${cell(i, m)}` : "").filter(Boolean).join(" · ").slice(0, 500);
    const co = { co: v("co"), web: v("web"), city: v("city"), hook: v("hook"), url: v("url"), note };
    return Array.from({ length: n }, (_, k) => {
      const name = n === 1 ? v("name") || [v("first"), v("last")].filter(Boolean).join(" ") : names[k] || [firsts[k], lasts[k]].filter(Boolean).join(" ");
      /* "Herr Dr. Max Muster" in one cell: the title goes to the salutation */
      const [, title, p] = name.match(/^((?:(?:Herr|Frau|Prof\.|Dr\.)\s+)*)(.*)$/)!;
      const [sal, role, email, phone, li] = (["sal", "role", "email", "phone", "li"] as Field[]).map(f => pick(f, k));
      return { ...co, sal: sal || title.trim(), p: p.trim(), role, email, phone, li };
    }).filter((r, k) => !k || r.p || r.email);
  }).filter(r => r.co);
}
