import { and, eq, inArray } from "drizzle-orm";
import { db, leads } from "@/db";
import { attachCompanies, norm } from "@/lib/companies";
import { HubSpotError, hubspotKnown, hubspotToken, type Known } from "@/lib/hubspot";
import { guessSalutations, jevKey } from "@/lib/jev";
import { emailTypeOf, httpUrl, salutationOf, validEmail } from "@/lib/lead-fields";
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
const fillOf = (r: LeadRow, l: Record<string, string>) => Object.fromEntries(FILL.flatMap(([col, k]) => {
  const v = (col === "website" || col === "linkedin" || col === "sourceUrl" ? httpUrl(r[k] || "") : col === "salutation" ? salutationOf(r[k] || "") : (r[k] || "").trim());
  if (!v || (l[col] || "").trim() || (col === "email" && !validEmail(v))) return [];
  return col === "email" ? [[col, v], ["emailType", emailTypeOf(v, !!`${l.first}${l.last}`.trim())]] : [[col, v.slice(0, col === "note" ? 4000 : 500)]];
}));
const personKey = (co: string, p: string) => `${norm(co)}|${p.trim().toLowerCase().replace(/\s+/g, " ")}`;

/* One person per company gets the mail; further people at that company are kept as contacts, also without an address.
   A person already in the list (same address, or same name at the same company) is not added again;
   where the row knows more (phone, role, …) it fills the empty fields of that lead.
   Only rows that add nothing are dropped. */
export async function checkLeads(tenantId: number, input: LeadRow[]): Promise<CheckedRow[]> {
  /* AI and pasted text bring quotes and Markdown along; links keep their target */
  const rows = input.map(r => ({ ...r, co: clean(r.co), sal: clean(r.sal || ""), p: clean(r.p), role: clean(r.role), phone: clean(r.phone || "").slice(0, 120), city: clean(r.city), hook: clean(r.hook || ""), note: clean(r.note || "").slice(0, 500) })).filter(r => r.co);
  const prev = await db.select({ id: leads.id, c: leads.company, first: leads.first, last: leads.last, email: leads.email, s: leads.status,
    role: leads.role, phone: leads.phone, city: leads.city, website: leads.website, linkedin: leads.linkedin, sourceUrl: leads.sourceUrl, note: leads.note, salutation: leads.salutation }).from(leads).where(eq(leads.tenantId, tenantId));
  const companies = new Set(prev.map(r => norm(r.c)));
  const live = prev.filter(r => r.s !== "papierkorb");
  const keyOf = (r: { c: string; first: string; last: string }) => r.first || r.last ? personKey(r.c, `${r.first} ${r.last}`) : "";
  const byName = new Map(live.filter(keyOf).map(r => [keyOf(r), r]));
  /* one address can be shared by several people (info@, wp-berlin@): it only makes a duplicate when the person is the same or unnamed */
  const owners = new Map<string, Set<string>>();
  const own = (e: string, k: string) => { if (!owners.has(e)) owners.set(e, new Set()); owners.get(e)!.add(k); };
  prev.forEach(r => { if (r.email) own(r.email.toLowerCase(), keyOf(r)); });
  const byEmail = new Map(live.filter(r => r.email).map(r => [r.email.toLowerCase(), r]));
  const sameMail = (e: string, k: string) => !!e && !!owners.get(e) && (!k || owners.get(e)!.has(k) || owners.get(e)!.has(""));
  const names = new Set<string>();
  /* trashed leads stay in the list, so they are recognised when they turn up again */
  const trashed = new Set(prev.filter(r => r.s === "papierkorb").map(r => r.email.toLowerCase()).filter(Boolean));
  const hub = await hubspotToken(tenantId);
  /* unreachable is not "not in HubSpot": such rows are held back instead of imported blindly */
  const inHub = hub ? await pool(rows, 4, r => hubKnown(hub, r).catch(e => { console.error(e); return HUB_DOWN; })) : rows.map(() => null);
  const out = rows.map((r, i) => {
    const h = inHub[i], hit = typeof h === "object" ? h : null;
    /* a broken address is dropped, the contact stays */
    const raw = (r.email || "").trim(), bad = !!raw && !validEmail(raw), email = bad ? "" : raw.toLowerCase(), known = companies.has(norm(r.co)) || !!hit;
    const key = r.p.trim() ? personKey(r.co, r.p) : "", twice = !!key && names.has(key);
    const mailOld = email ? byEmail.get(email) : undefined;
    const old = twice ? null : (key && byName.get(key)) || (mailOld && keyOf(mailOld) === key ? mailOld : null);
    const fill = old ? fillOf(r, old as unknown as Record<string, string>) : {};
    const dup = email && trashed.has(email) && sameMail(email, key) ? "Im Papierkorb" : twice ? "Doppelt in der Datei" : old ? (Object.keys(fill).length ? "" : "Schon in der Liste") : sameMail(email, key) ? "Schon in der Liste"
      : h === HUB_DOWN ? HUB_DOWN : hit?.why === "Kontakt in HubSpot" ? "Kontakt in HubSpot" : known && !email && !key ? "Firma bekannt" : "";
    const extra = dup ? "" : old ? "Wird ergänzt" : bad ? "E-Mail ungültig" : known ? "Weiterer Kontakt" : "";
    companies.add(norm(r.co)); if (email) own(email, key); if (key) names.add(key);
    return { ...r, email: bad ? "" : r.email, sal: salutationOf(r.sal || ""), dup, extra, ...(old && !dup ? { id: old.id } : {}) };
  });
  /* No Herr/Frau in the source: Jev guesses from name and role, a title found in the text is kept */
  const open = out.map((r, i) => i).filter(i => out[i].p && !out[i].sal);
  const jev = open.length ? await jevKey(tenantId) : null;
  if (jev) {
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
