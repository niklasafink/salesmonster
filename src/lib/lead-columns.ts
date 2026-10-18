/* Column mapping for pasted or uploaded lead tables. Pure, so the import dialog can use it too. */

/* CRM fields a column can feed; "" = ignore the column */
export const FIELDS = {
  co: "Firma",
  sal: "Anrede",
  first: "Vorname",
  last: "Nachname",
  name: "Vor- und Nachname",
  role: "Rolle",
  email: "E-Mail",
  web: "Website",
  city: "Ort",
  li: "LinkedIn",
  hook: "Anlass",
  url: "Quell-Link",
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
  ["web", /^(website|webseite|homepage|internet|url|web|domain)$/],
  ["city", /^(ort|stadt|city|standort|location|town)$/],
  ["li", /^(linkedin|linkedinurl|linkedinprofil|linkedinprofile)$/],
];
const headField = (h: string): Field => HEAD.find(([, re]) => re.test(h.toLowerCase().replace(/[\s_.\-:/()]/g, "")))?.[0] ?? "";
/* Fields by header name alone; "Name" next to "Vorname" is the family name */
export function headFields(head: string[]): Field[] {
  const f = head.map(headField);
  if (f.includes("first") && !f.includes("last")) { const i = f.indexOf("name"); if (i >= 0) f[i] = "last"; }
  return f;
}

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
const cellOf = (raw: string, f: Field) => f === "web" || f === "url" || f === "li" ? link(raw) : clean(raw);

/* Do the values fit the field? Header names and Jev both misjudge, e.g. "Standort" holding dates or notes. */
const URL_RE = /^(https?:\/\/|www\.)\S+$|^[\w-]+(\.[\w-]+)+(\/\S*)?$/i;
const FITS: Partial<Record<Field, (v: string) => boolean>> = {
  co: v => v.length <= 100,
  sal: v => v.length <= 30,
  first: v => v.length <= 40 && !/[\d@]/.test(v),
  last: v => v.length <= 40 && !/[\d@]/.test(v),
  name: v => v.length <= 60 && !/[\d@;]/.test(v),
  /* codes like "A" or "R1" are no role and stay out */
  role: v => v.length <= 100 && !/@/.test(v) && !/^[A-Z]{0,2}\d{0,2}$/i.test(v),
  note: v => !/^[A-Z]{0,2}\d{0,2}$/i.test(v),
  email: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
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
    return { head, samples, field: fits(f[i], samples) ? f[i] : "" };
  });
}

export type MappedRow = { co: string; sal: string; p: string; role: string; email: string; web: string; city: string; li: string; hook: string; url: string; note: string };

/* Applies the reviewed mapping; columns set to "" are ignored, rows without a company are dropped.
   Several columns on one field: the first non-empty cell wins (e.g. "E-Mail 1", "E-Mail 2");
   columns on Notiz are collected as "Spalte: Wert", so side facts sit in one short text instead of fields of their own. */
export function applyMap(t: { head: string[]; rows: string[][] }, map: Field[]): MappedRow[] {
  return t.rows.map(c => {
    /* a cell that does not fit its field (a code as role, a date as city) is left out, the rest of the row stays;
       a broken address goes on, so the review can flag it */
    const cell = (i: number, f: Field) => { const x = cellOf(c[i] || "", f); return f === "co" || f === "email" || !FITS[f] || FITS[f]!(x) ? x : ""; };
    const v = (f: Field) => map.reduce<string>((acc, m, i) => acc || (m === f ? cell(i, f) : ""), "");
    /* "Herr Dr. Max Muster" in one cell: the title goes to the salutation */
    const [, title, p] = (v("name") || [v("first"), v("last")].filter(Boolean).join(" ")).match(/^((?:(?:Herr|Frau|Prof\.|Dr\.)\s+)*)(.*)$/)!;
    const note = map.map((m, i) => m === "note" && cell(i, m) ? `${t.head[i]}: ${cell(i, m)}` : "").filter(Boolean).join(" · ").slice(0, 500);
    return { co: v("co"), sal: v("sal") || title.trim(), p: p.trim(), role: v("role"), email: v("email"), web: v("web"), city: v("city"), li: v("li"), hook: v("hook"), url: v("url"), note };
  }).filter(r => r.co);
}
