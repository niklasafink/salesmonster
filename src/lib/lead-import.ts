import { and, eq, inArray } from "drizzle-orm";
import { db, leads } from "@/db";
import { attachCompanies, norm } from "@/lib/companies";
import { HubSpotError, domainOf, hubspotKnown, hubspotToken, type Known } from "@/lib/hubspot";
import { guessSalutations, jevKey, samePeople } from "@/lib/jev";
import { emailTypeOf, httpUrl, salutationOf, validEmail } from "@/lib/lead-fields";
import { FREEMAIL } from "@/lib/lead-rating";
import { pool } from "@/lib/outreach";
import { clean } from "@/lib/lead-columns";

/* One imported contact as the parser, the import dialog and MCP hand it over; several rows with the same co are contacts of one company */
export type LeadRow = { co: string; sal?: string; p: string; role: string; email: string; phone?: string; web: string; city: string; li?: string; hook?: string; url?: string; note?: string; research?: string };
/* id: an existing lead this row only completes (fields that are empty there) */
export type CheckedRow = LeadRow & { sal: string; dup: string; extra: string; id?: number };

const HUB_DOWN = "HubSpot nicht erreichbar";
/* HubSpot allows a few requests per second: 4 at a time, a 429 gets two more tries */
async function hubKnown(token: string, r: LeadRow): Promise<Known | null> {
  for (let i = 0; ; i++) {
    try { return await hubspotKnown(token, r.co, r.web, r.email); }
    catch (e) { if (!(e instanceof HubSpotError && e.status === 429) || i === 2) throw e; await new Promise(res => setTimeout(res, 400 * (i + 1))); }
  }
}

/* Fields an import may fill in on a lead that already exists, as lead column and row key */
const FILL = [["email", "email"], ["role", "role"], ["phone", "phone"], ["city", "city"], ["website", "web"], ["linkedin", "li"], ["sourceUrl", "url"], ["note", "note"], ["salutation", "sal"]] as const;
const fillOf = (r: LeadRow, l: Record<string, string>) => ({ ...nameFill(r, l), ...Object.fromEntries(FILL.flatMap(([col, k]) => {
  const v = (col === "website" || col === "linkedin" || col === "sourceUrl" ? httpUrl(r[k] || "") : col === "salutation" ? salutationOf(r[k] || "") : (r[k] || "").trim());
  if (!v || (l[col] || "").trim() || (col === "email" && !validEmail(v))) return [];
  return col === "email" ? [[col, v], ["emailType", emailTypeOf(v, !!`${l.first}${l.last}`.trim() || !!r.p?.trim())]] : [[col, v.slice(0, col === "note" ? 4000 : 500)]];
})) });
/* A lead without a name gets the row's; "H. Müller" becomes "Hans Müller" */
const nameFill = (r: LeadRow, l: Record<string, string>) => {
  const [first, ...rest] = (r.p || "").trim().split(/\s+/), last = rest.join(" ");
  if (!first) return {};
  if (!`${l.first}${l.last}`.trim()) return { first, last };
  const ini = /^\p{L}\.?$/u.test(l.first || "");
  return ini && first.length > 2 && fold(first)[0] === fold(l.first)[0] && fold(last) === fold(l.last || "") ? { first } : {};
};

/* Names compared without case, titles, umlaut spelling and punctuation: "Dr. Hans-Peter Müller" = "hans peter mueller" */
const TITLES = new Set(["dr", "prof", "dipl", "ing", "herr", "frau", "mba", "msc", "bsc", "mag", "med", "rer", "nat", "phil", "jur", "oec", "kfm", "hc"]);
const fold = (s: string) => s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const nameOf = (p: string) => fold(p).split(/[^a-z0-9]+/).filter(w => w && !TITLES.has(w));
/* edit distance, only needed up to 2 */
function lev(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/* A contact as the duplicate check sees it: company by name and by domain (website, else a company address) */
type Who = { co: string; n: string[]; dom: string; email: string; desc: string };
const whoOf = (co: string, p: string, web: string, email: string, role: string, city: string): Who => {
  const e = email.trim().toLowerCase();
  const dom = (web && domainOf(web)) || (e.includes("@") && !FREEMAIL.test(e) ? e.split("@")[1] : "");
  return { co: norm(fold(co)), n: nameOf(p), dom, email: e, desc: [p.trim() || "(no name)", role, co, e, web, city].filter(Boolean).join(", ") };
};
const sameCo = (a: Who, b: Who) => (!!a.co && a.co === b.co) || (!!a.dom && a.dom === b.dom);
const likeCo = (a: Who, b: Who) => a.co.length >= 4 && b.co.length >= 4 && (a.co.includes(b.co) || b.co.includes(a.co) || (a.co.length >= 6 && lev(a.co, b.co) <= 2));
const sameName = (a: Who, b: Who) => !!a.n.length && a.n.join(" ") === b.n.join(" ");
/* same last name and a fitting first name (initial, short form, double name), or a small typo */
const likeName = (a: Who, b: Who) => {
  if (!a.n.length || !b.n.length) return false;
  const [x, y] = [a.n.join(" "), b.n.join(" ")];
  if (x.length >= 6 && lev(x, y) <= 2) return true;
  if (a.n.length < 2 || b.n.length < 2 || a.n.at(-1) !== b.n.at(-1)) return false;
  const [f, g] = [a.n[0], b.n[0]];
  return f === g || ((f.length === 1 || g.length === 1) && f[0] === g[0]) || (Math.min(f.length, g.length) >= 3 && (f.startsWith(g) || g.startsWith(f)));
};
/* sure: the same person for certain; maybe: Jev decides */
function relate(a: Who, b: Who): "sure" | "maybe" | "" {
  if (a.email && a.email === b.email) {
    if (!a.n.length || !b.n.length || sameName(a, b) || likeName(a, b)) return "sure";
    return ""; /* a shared address (info@) of two different people */
  }
  if (sameCo(a, b)) return sameName(a, b) ? "sure" : likeName(a, b) ? "maybe" : "";
  return likeCo(a, b) && (sameName(a, b) || likeName(a, b)) ? "maybe" : "";
}
/* first sure match, else first maybe */
function closest(a: Who, list: Who[], upTo = list.length) {
  let maybe = -1;
  for (let j = 0; j < upTo; j++) {
    const r = relate(a, list[j]);
    if (r === "sure") return { j, sure: true };
    if (r === "maybe" && maybe < 0) maybe = j;
  }
  return maybe < 0 ? null : { j: maybe, sure: false };
}

/* One person per company gets the mail; further people at that company are kept as contacts, also without an address.
   A person already in the list or earlier in the file is not added again: clear cases by address or by name at the
   same company (titles, umlauts, legal form and domain ignored); unclear ones (initials, typos, a similar company name)
   go to Jev. Where the row knows more (phone, role, …) it fills the empty fields of that lead or of the earlier row.
   Only rows that add nothing are dropped. Without an answer from Jev an unclear row is kept and marked. */
export async function checkLeads(tenantId: number, input: LeadRow[]): Promise<CheckedRow[]> {
  /* AI and pasted text bring quotes and Markdown along; links keep their target */
  const rows = input.map(r => ({ ...r, co: clean(r.co), sal: clean(r.sal || ""), p: clean(r.p), role: clean(r.role), phone: clean(r.phone || "").slice(0, 120), city: clean(r.city), hook: clean(r.hook || ""), note: clean(r.note || "").slice(0, 500) })).filter(r => r.co);
  /* trashed leads stay in the list, so they are recognised when they turn up again */
  const prev = await db.select({ id: leads.id, c: leads.company, first: leads.first, last: leads.last, email: leads.email, s: leads.status,
    role: leads.role, phone: leads.phone, city: leads.city, website: leads.website, linkedin: leads.linkedin, sourceUrl: leads.sourceUrl, note: leads.note, salutation: leads.salutation }).from(leads).where(eq(leads.tenantId, tenantId))
    .then(r => r.sort((a, b) => Number(a.s === "papierkorb") - Number(b.s === "papierkorb"))); /* a live lead wins over a trashed copy */
  const known = prev.map(l => whoOf(l.c, `${l.first} ${l.last}`, l.website, l.email, l.role, l.city));
  const valid = (e: string) => { const t = (e || "").trim(); return t && validEmail(t) ? t : ""; };
  const mine = () => rows.map(r => whoOf(r.co, r.p, r.web, valid(r.email), r.role, r.city));
  const who = mine();

  /* Candidates in the file (earlier rows) and in the list; the unclear pairs go to Jev in one go */
  const inFile = who.map((w, i) => closest(w, who, i));
  const inList = who.map(w => closest(w, known));
  const ask: { i: number; file: boolean; j: number }[] = [];
  who.forEach((w, i) => {
    if (inFile[i] && !inFile[i]!.sure) ask.push({ i, file: true, j: inFile[i]!.j });
    if (inList[i] && !inList[i]!.sure) ask.push({ i, file: false, j: inList[i]!.j });
  });
  const jev = ask.length || rows.some(r => r.p && !r.sal) ? await jevKey(tenantId) : null;
  const said = ask.length && jev ? await samePeople(jev, ask.map(a => [who[a.i].desc, (a.file ? who[a.j] : known[a.j]).desc] as [string, string])).catch(e => { console.error(e); return null; }) : null;
  const yes = (i: number, file: boolean) => { const k = ask.findIndex(a => a.i === i && a.file === file); return k >= 0 && !!said?.[k]; };
  const unsure = new Set(said ? [] : ask.map(a => a.i));

  /* Rows of one person in the file collapse into the first; it takes over what the later ones know */
  const rep = rows.map((_, i) => i);
  rows.forEach((r, i) => {
    const f = inFile[i];
    if (!f || !(f.sure || yes(i, true))) return;
    const to = rep[i] = rep[f.j];
    const t = rows[to] as Record<string, string | undefined>;
    for (const [k, v] of Object.entries(r)) if (typeof v === "string" && v.trim() && !(t[k] || "").trim()) t[k] = k === "email" && !validEmail(v.trim()) ? t[k] : v;
  });
  const merged = mine();
  /* the list match of a collapsed group: its own, else a later row's, else again with the merged fields */
  const oldOf = rows.map(() => -1);
  rows.forEach((_, i) => {
    const l = inList[i], hit = l && (l.sure || yes(i, false)) ? l.j : -1;
    if (hit >= 0 && oldOf[rep[i]] < 0) oldOf[rep[i]] = hit;
  });
  rows.forEach((_, i) => { if (rep[i] === i && oldOf[i] < 0) { const c = closest(merged[i], known); if (c?.sure) oldOf[i] = c.j; } });

  const coKnown = new Set(known.flatMap(w => [w.co && `n:${w.co}`, w.dom && `d:${w.dom}`].filter(Boolean)));
  const hub = await hubspotToken(tenantId);
  /* unreachable is not "not in HubSpot": such rows are held back instead of imported blindly */
  const inHub = hub ? await pool(rows.map((r, i) => ({ r, i })), 4, ({ r, i }) => rep[i] !== i ? Promise.resolve(null) : hubKnown(hub, r).catch(e => { console.error(e); return HUB_DOWN; })) : rows.map(() => null);
  const seen = new Set<string>();
  const out = rows.map((r, i) => {
    const sal = salutationOf(r.sal || "");
    if (rep[i] !== i) return { ...r, sal, dup: "Doppelt in der Datei", extra: "" };
    const h = inHub[i], hit = typeof h === "object" ? h : null, w = merged[i];
    /* a broken address is dropped, the contact stays */
    const raw = (r.email || "").trim(), bad = !!raw && !validEmail(raw);
    const isKnown = [w.co && `n:${w.co}`, w.dom && `d:${w.dom}`].some(k => k && (coKnown.has(k) || seen.has(k))) || !!hit;
    const o = oldOf[i] >= 0 ? prev[oldOf[i]] : null;
    const fill = o && o.s !== "papierkorb" ? fillOf(r, o as unknown as Record<string, string>) : {};
    const dup = o?.s === "papierkorb" ? "Im Papierkorb" : o ? (Object.keys(fill).length ? "" : "Schon in der Liste")
      : h === HUB_DOWN ? HUB_DOWN : hit?.why === "Kontakt in HubSpot" ? "Kontakt in HubSpot" : isKnown && !w.email && !w.n.length ? "Firma bekannt" : "";
    const extra = dup ? "" : o ? "Wird ergänzt" : unsure.has(i) ? "Möglicherweise doppelt" : bad ? "E-Mail ungültig" : isKnown ? "Weiterer Kontakt" : "";
    if (w.co) seen.add(`n:${w.co}`); if (w.dom) seen.add(`d:${w.dom}`);
    return { ...r, email: bad ? "" : r.email, sal, dup, extra, ...(o && !dup ? { id: o.id } : {}) };
  });
  /* No Herr/Frau in the source: Jev guesses from name and role, a title found in the text is kept */
  const open = out.map((r, i) => i).filter(i => !out[i].dup && out[i].p && !out[i].sal);
  if (jev && open.length) {
    const g = await guessSalutations(jev, open.map(i => { const [first, ...rest] = out[i].p.trim().split(/\s+/); return { first, last: rest.join(" "), role: out[i].role }; })).catch(() => []);
    open.forEach((i, k) => { if (g[k]) out[i].sal = salutationOf(`${g[k]} ${rows[i].sal || ""}`); });
  }
  return out;
}

/* Inserts rows as given (the dialog already left out duplicates) and files them under their company */
export async function insertLeads(tenantId: number, rows: LeadRow[], source: string) {
  if (!rows.length) return [];
  const vals = rows.map(r => {
    const [first, ...rest] = (r.p || "").trim().split(/\s+/);
    const email = validEmail((r.email || "").trim()) ? (r.email || "").trim() : "";
    return { tenantId, company: r.co.trim(), first: r.p ? first : "", last: r.p ? rest.join(" ") : "", role: r.role || "",
      email, emailType: emailTypeOf(email, !!r.p?.trim()), phone: (r.phone || "").trim().slice(0, 120), website: httpUrl(r.web || ""),
      city: r.city || "", salutation: salutationOf(r.sal || ""), linkedin: httpUrl(r.li || ""), hook: r.hook || "", note: (r.note || "").slice(0, 4000), research: (r.research || "").slice(0, 4000), sourceUrl: httpUrl(r.url || ""), source: source || "Import", status: "neu" };
  });
  const ids = (await db.insert(leads).values(vals).returning({ id: leads.id })).map(r => r.id);
  await attachCompanies(tenantId);
  const got = new Map((await db.select({ id: leads.id, company: leads.company, companyId: leads.companyId }).from(leads).where(inArray(leads.id, ids))).map(r => [r.id, r]));
  return ids.map(id => got.get(id)!);
}

/* Rows that complete an existing lead: only its empty fields are set, nothing is overwritten */
export async function fillLeads(tenantId: number, rows: (LeadRow & { id: number })[]) {
  const ids: number[] = [];
  for (const r of rows) {
    const [l] = await db.select().from(leads).where(and(eq(leads.id, r.id), eq(leads.tenantId, tenantId)));
    if (!l) continue;
    const set = fillOf(r, l as unknown as Record<string, string>);
    if (Object.keys(set).length) { await db.update(leads).set(set).where(eq(leads.id, l.id)); ids.push(l.id); }
  }
  return ids;
}

/* Check and insert in one go, for callers without a preview step */
export async function addLeads(tenantId: number, rows: LeadRow[], source: string) {
  const checked = await checkLeads(tenantId, rows);
  const added = await insertLeads(tenantId, checked.filter(r => !r.dup && !r.id), source);
  await fillLeads(tenantId, checked.filter((r): r is CheckedRow & { id: number } => !r.dup && !!r.id));
  return { added, skipped: checked.filter(r => r.dup).map(r => ({ company: r.co, why: r.dup })) };
}
