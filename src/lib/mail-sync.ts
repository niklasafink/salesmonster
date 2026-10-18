import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, leads, mailContacts, mailSyncs, tenants, type MailCursor, type SigData } from "@/db";
import { aiFor } from "./ai";
import { attachCompanies } from "./companies";
import { domainOf } from "./hubspot";
import { INFO_MAIL, emailTypeOf, salutationOf } from "./lead-fields";
import { openSource, type Head, type Source } from "./mail-source";
import { rerate } from "./ratings";
import { readSignature, readSignatures, signatureOf } from "./signature";

/* Attio-style: everyone a mailbox exchanged mail with becomes a contact of the tenant, with what their signature says.
   Runs in steps (scan headers → read signatures → file as leads) so a page or the cron can drive it within a function's time */

const AUTO = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|notify|newsletters?|news|marketing|alerts?|updates?|system|automated|calendar|invitations?|unsubscribe|feedback|survey|billing|invoices?|rechnung(en)?|buchhaltung|accounting|receipts?|orders?|bestellung(en)?|versand|shipping|support|helpdesk|ticket|tickets|mailer|daemon|robot|bot|webmaster|hostmaster|security|reply|antwort|jobs|bewerbung|karriere|press|presse)([._+-]|$)/i;
const SERVICES = /(^|\.)(linkedin\.com|facebookmail\.com|google\.com|googlegroups\.com|amazonses\.com|amazon\.(de|com)|sendgrid\.net|mailchimp(app)?\.(com|net)|mcsv\.net|mandrillapp\.com|hubspot(email)?\.(com|net)|hs-?\w*\.(com|net)|salesforce\.com|zendesk\.com|intercom(-mail)?\.(com|io)|github\.com|slack\.com|atlassian\.(net|com)|notion\.so|stripe\.com|paypal\.(de|com)|microsoft\.com|microsoftonline\.com|office\.com|office365\.com|calendly\.com|docusign\.net|xing\.com|zoom\.us|teams\.microsoft\.com|apple\.com|vercel\.com|cloudflare\.com|figma\.com|canva\.com|substack\.com|medium\.com|eventbrite\.\w+|typeform\.com|mailjet\.com|sendinblue\.com|brevo\.com|klaviyo\.com|lexoffice\.de|sevdesk\.de|datev\.de|ebay\.\w+|youtube\.com|meta\.com|whatsapp\.com|anthropic\.com|openai\.com|neon\.tech)$/i;
export const FREEMAIL = new Set(["gmail.com", "googlemail.com", "gmx.de", "gmx.net", "gmx.at", "gmx.ch", "web.de", "t-online.de", "yahoo.com", "yahoo.de", "outlook.com", "outlook.de",
  "hotmail.com", "hotmail.de", "live.com", "live.de", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "aol.de", "freenet.de", "posteo.de", "mailbox.org", "proton.me", "protonmail.com", "arcor.de", "online.de", "1und1.de", "email.de", "vodafone.de"]);

/* A person, not a system, a mailing list or a colleague */
function personAddr(email: string, own: Set<string>) {
  const [local, domain] = email.split("@");
  if (!local || !domain || own.has(domain)) return false;
  if (AUTO.test(local) || INFO_MAIL.test(email) || SERVICES.test(domain)) return false;
  /* tracking and bounce addresses: plus tags, long random tokens */
  if (local.includes("+") || /[0-9a-f]{16,}|\d{6,}/i.test(local) || local.length > 40) return false;
  return true;
}

/* Someone the person really corresponds with: wrote to them at least once, or got two direct mails that were not bulk */
const ELIGIBLE = or(gt(mailContacts.sent, 0), sql`${mailContacts.direct} >= 2`);

export async function syncState(tenantId: number, userId: number) {
  const [s] = await db.select().from(mailSyncs).where(and(eq(mailSyncs.tenantId, tenantId), eq(mailSyncs.userId, userId)));
  if (!s) return null;
  const [n] = await db.select({ contacts: sql<number>`count(*) filter (where ${ELIGIBLE})::int`, imported: sql<number>`count(${mailContacts.leadId})::int` })
    .from(mailContacts).where(and(eq(mailContacts.tenantId, tenantId), eq(mailContacts.userId, userId)));
  return { status: s.status, phase: s.phase, scanned: s.scanned, contacts: n.contacts, imported: n.imported, error: s.error, finishedAt: s.finishedAt?.toISOString() ?? null };
}

/* Starts a run, or picks up mail since the last one. A running sync is left as it is */
export async function startSync(tenantId: number, userId: number, source: string) {
  await db.insert(mailSyncs).values({ tenantId, userId, source }).onConflictDoUpdate({
    target: [mailSyncs.tenantId, mailSyncs.userId],
    set: { status: "läuft", error: "", source, startedAt: new Date(), finishedAt: null,
      /* after a finished run only new mail is read, after an error the run resumes, a different mailbox starts from the beginning */
      cursor: sql`case when ${mailSyncs.source} <> ${source} then '{}'::jsonb when ${mailSyncs.status} = 'fertig' then ${mailSyncs.cursor} - 'next' else ${mailSyncs.cursor} end`,
      phase: sql`case when ${mailSyncs.source} = ${source} and ${mailSyncs.status} = 'fehler' then ${mailSyncs.phase} else 'scan' end`,
      lastMailAt: sql`case when ${mailSyncs.source} = ${source} then ${mailSyncs.lastMailAt} else null end` },
    setWhere: sql`${mailSyncs.status} <> 'läuft' or ${mailSyncs.source} <> ${source}`,
  });
}

/* Forgets the contacts read from this mailbox (not the leads made from them) */
export async function resetSync(tenantId: number, userId: number) {
  await db.delete(mailSyncs).where(and(eq(mailSyncs.tenantId, tenantId), eq(mailSyncs.userId, userId)));
  await db.delete(mailContacts).where(and(eq(mailContacts.tenantId, tenantId), eq(mailContacts.userId, userId)));
}

type Tally = { name: string; sent: number; received: number; direct: number; first: Date; last: Date };

/* Counts per address for one page of headers */
function tally(heads: Head[], me: string, own: Set<string>) {
  const m = new Map<string, Tally>();
  const hit = (a: { email: string; name: string }, d: Date, f: (t: Tally) => void) => {
    if (!personAddr(a.email, own)) return;
    const t = m.get(a.email) || { name: "", sent: 0, received: 0, direct: 0, first: d, last: d };
    if (a.name && !a.name.includes("@") && a.name.length > t.name.length) t.name = a.name;
    if (d < t.first) t.first = d; if (d > t.last) t.last = d;
    f(t); m.set(a.email, t);
  };
  for (const h of heads) {
    if (h.outgoing) for (const a of h.to) hit(a, h.date, t => t.sent++);
    else if (h.from) hit(h.from, h.date, t => { t.received++; if (!h.bulk && h.to.some(a => a.email === me)) t.direct++; });
  }
  return m;
}

async function store(tenantId: number, userId: number, m: Map<string, Tally>) {
  const rows = [...m].map(([email, t]) => ({ tenantId, userId, email, name: t.name, sent: t.sent, received: t.received, direct: t.direct, firstAt: t.first, lastAt: t.last }));
  for (let i = 0; i < rows.length; i += 200) await db.insert(mailContacts).values(rows.slice(i, i + 200)).onConflictDoUpdate({
    target: [mailContacts.tenantId, mailContacts.userId, mailContacts.email],
    set: {
      sent: sql`${mailContacts.sent} + excluded.sent`, received: sql`${mailContacts.received} + excluded.received`, direct: sql`${mailContacts.direct} + excluded.direct`,
      name: sql`case when length(excluded.name) > length(${mailContacts.name}) then excluded.name else ${mailContacts.name} end`,
      firstAt: sql`least(${mailContacts.firstAt}, excluded.first_at)`, lastAt: sql`greatest(${mailContacts.lastAt}, excluded.last_at)`,
      /* someone who writes again may have a new signature or a new job */
      state: sql`case when ${mailContacts.state} = 'fertig' and excluded.received > 0 then 'offen' else ${mailContacts.state} end`,
    },
  });
}

/* "Müller, Anna" → "Anna Müller"; display names that are just the address are dropped */
const cleanName = (n: string) => {
  const x = n.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s*[|/–-]\s+.*$/, "").trim();
  return /,/.test(x) && x.split(",").length === 2 ? x.split(",").map(s => s.trim()).reverse().join(" ") : x;
};

async function readBatch(src: Source, tenantId: number, userId: number) {
  const open = await db.select().from(mailContacts).where(and(eq(mailContacts.tenantId, tenantId), eq(mailContacts.userId, userId), eq(mailContacts.state, "offen"), ELIGIBLE)).limit(12);
  if (!open.length) return 0;
  const xs = [];
  for (const c of open) {
    const bodies = c.received ? await src.bodies(c.email, 3).catch(() => []) : [];
    const signature = signatureOf(bodies), name = cleanName(c.name);
    xs.push({ id: c.id, email: c.email, name, signature, rules: readSignature(signature, name, c.email) });
  }
  const ai = await aiFor(tenantId, userId);
  const withSig = xs.filter(x => x.signature);
  const read = ai && withSig.length ? await readSignatures(ai, withSig).catch(e => { console.error(e); return null; }) : null;
  for (const x of xs) await db.update(mailContacts).set({ signature: x.signature, parsed: read?.get(x.email) ?? x.rules, state: "gelesen" }).where(eq(mailContacts.id, x.id));
  return open.length;
}

const domainLabel = (d: string) => d.split(".").slice(0, -1).join(" ").split(/[-_ ]/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
const most = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0] || "";

/* Read contacts become leads with status "kontakt" (never cold-mailed); known addresses get the missing fields filled in */
async function file(tenantId: number, userId: number) {
  const read = await db.select().from(mailContacts).where(and(eq(mailContacts.tenantId, tenantId), eq(mailContacts.userId, userId), eq(mailContacts.state, "gelesen")));
  if (!read.length) return 0;
  const have = await db.select({ id: leads.id, email: leads.email, company: leads.company, website: leads.website, status: leads.status, phone: leads.phone, role: leads.role,
    linkedin: leads.linkedin, salutation: leads.salutation, first: leads.first, last: leads.last, city: leads.city }).from(leads).where(eq(leads.tenantId, tenantId));
  const byEmail = new Map(have.filter(l => l.email).map(l => [l.email.toLowerCase(), l]));
  const known = new Map<string, string[]>();
  for (const l of have) if (l.website) { const d = domainOf(l.website); known.set(d, [...(known.get(d) || []), l.company]); }
  const dom = (c: typeof read[number]) => c.email.split("@")[1];
  /* one company name per domain, so colleagues land in the same company */
  const coOf = new Map<string, string>();
  for (const d of new Set(read.map(dom))) {
    if (FREEMAIL.has(d)) continue;
    coOf.set(d, most(known.get(d) || []) || most(read.filter(c => dom(c) === d).map(c => c.parsed?.company || "").filter(Boolean)) || domainLabel(d));
  }
  let n = 0;
  for (const c of read) {
    const p: SigData = c.parsed || readSignature("", cleanName(c.name), c.email), d = dom(c);
    const company = FREEMAIL.has(d) ? p.company : coOf.get(d)!;
    if (!company) { await db.update(mailContacts).set({ state: "aus" }).where(eq(mailContacts.id, c.id)); continue; }
    const phone = [p.phone, p.mobile && p.mobile !== p.phone ? `mobil ${p.mobile}` : ""].filter(Boolean).join(", ");
    const website = FREEMAIL.has(d) ? (p.website && !p.website.includes(d) ? p.website : "") : p.website || `https://${d}`;
    const l = byEmail.get(c.email);
    let leadId: number;
    if (l) {
      const fill = (k: "phone" | "role" | "linkedin" | "first" | "last" | "city", v: string) => !l[k] && v ? { [k]: v } : {};
      await db.update(leads).set({ ...fill("phone", phone), ...fill("role", p.role), ...fill("linkedin", p.linkedin), ...fill("first", p.first), ...fill("last", p.last), ...fill("city", p.city),
        ...(!l.salutation && p.salutation ? { salutation: salutationOf(p.salutation) } : {}),
        /* a lead that was about to be cold-mailed is an existing contact after all */
        ...(l.status === "neu" ? { status: "kontakt" } : {}), lastContactAt: c.lastAt }).where(eq(leads.id, l.id));
      leadId = l.id;
    } else {
      const [r] = await db.insert(leads).values({ tenantId, company, salutation: salutationOf(p.salutation), first: p.first, last: p.last, role: p.role, email: c.email,
        emailType: emailTypeOf(c.email, !!(p.first || p.last)), phone, linkedin: p.linkedin, website, city: p.city, source: "Postfach", status: "kontakt",
        research: c.signature ? `Signatur:\n${c.signature}` : "", lastContactAt: c.lastAt }).returning({ id: leads.id });
      leadId = r.id; n++;
    }
    await db.update(mailContacts).set({ state: "fertig", leadId }).where(eq(mailContacts.id, c.id));
  }
  await attachCompanies(tenantId);
  await rerate(tenantId);
  return n;
}

/* One step of the run within the time budget; returns the state for the caller to show */
export async function stepSync(tenantId: number, userId: number, budgetMs = 40_000) {
  const t0 = Date.now(), left = () => budgetMs - (Date.now() - t0);
  const [s] = await db.update(mailSyncs).set({ lockedUntil: new Date(Date.now() + budgetMs + 60_000) })
    .where(and(eq(mailSyncs.tenantId, tenantId), eq(mailSyncs.userId, userId), eq(mailSyncs.status, "läuft"), or(isNull(mailSyncs.lockedUntil), lt(mailSyncs.lockedUntil, new Date()))))
    .returning();
  if (!s) return syncState(tenantId, userId);
  let src: Source | null = null;
  try {
    src = await openSource(tenantId, userId);
    if (!src) throw new Error("Kein Postfach verbunden");
    const [t] = await db.select({ domain: tenants.domain }).from(tenants).where(eq(tenants.id, tenantId));
    const own = new Set([src.me.split("@")[1], domainOf(t.domain)].filter(Boolean));
    let { phase } = s, cursor: MailCursor = s.cursor, scanned = s.scanned, lastMailAt = s.lastMailAt;
    while (left() > 8_000 && phase !== "fertig") {
      if (phase === "scan") {
        const pg = await src.page(cursor, cursor.next ? null : s.lastMailAt);
        await store(tenantId, userId, tally(pg.heads, src.me, own));
        scanned += pg.heads.length; cursor = pg.cursor;
        for (const h of pg.heads) if (!lastMailAt || h.date > lastMailAt) lastMailAt = h.date;
        if (pg.done) phase = "signatur";
        await db.update(mailSyncs).set({ cursor, scanned, phase, lastMailAt, updatedAt: new Date() }).where(eq(mailSyncs.id, s.id));
      } else if (phase === "signatur") {
        if (!await readBatch(src, tenantId, userId)) phase = "import";
        await db.update(mailSyncs).set({ phase, updatedAt: new Date() }).where(eq(mailSyncs.id, s.id));
      } else {
        await file(tenantId, userId);
        await db.update(leads).set({ lastContactAt: sql`(select max(${mailContacts.lastAt}) from ${mailContacts} where ${mailContacts.leadId} = ${leads.id})` })
          .where(and(eq(leads.tenantId, tenantId), inArray(leads.id, db.select({ id: mailContacts.leadId }).from(mailContacts).where(and(eq(mailContacts.tenantId, tenantId), eq(mailContacts.userId, userId))))));
        phase = "fertig";
        await db.update(mailSyncs).set({ phase, status: "fertig", finishedAt: new Date(), updatedAt: new Date() }).where(eq(mailSyncs.id, s.id));
      }
    }
  } catch (e) {
    console.error(e);
    await db.update(mailSyncs).set({ status: "fehler", error: (e as Error).message.slice(0, 300), updatedAt: new Date() }).where(eq(mailSyncs.id, s.id));
  } finally {
    await src?.close();
    await db.update(mailSyncs).set({ lockedUntil: null }).where(eq(mailSyncs.id, s.id));
  }
  return syncState(tenantId, userId);
}

/* Cron: continue running syncs and pick up new mail for finished ones, within one function's time */
export async function syncAll(budgetMs: number) {
  const t0 = Date.now();
  const all = await db.select({ tenantId: mailSyncs.tenantId, userId: mailSyncs.userId, status: mailSyncs.status, source: mailSyncs.source }).from(mailSyncs);
  for (const s of all) {
    const left = budgetMs - (Date.now() - t0);
    if (left < 20_000) break;
    if (s.status !== "läuft") await startSync(s.tenantId, s.userId, s.source);
    await stepSync(s.tenantId, s.userId, Math.min(left - 10_000, 120_000));
  }
}
