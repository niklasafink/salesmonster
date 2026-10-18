import { and, asc, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { claims, companies, db, leads, members, messages, runs, templates, tenants, users } from "@/db";
import { attachCompanies, norm, plan, type Unit } from "./companies";
import { salutationOf } from "./lead-fields";
import { berlinDate } from "./dates";
import { getInteg } from "./integrations";
import { enrichLead, researchLeads, type LeadOut } from "./claude";
import { AiMissing, aiFor } from "./ai";
import { HubSpotError, domainOf, hubspotAddContact, hubspotCreateContact, hubspotKnown, hubspotPortal, hubspotReserve, hubspotToken, type Known } from "./hubspot";
import { hasReply, sendAs, sendSystem } from "./mail";
import { JevLimit, guessSalutations, jevKey, scoreMail } from "./jev";

type Tenant = typeof tenants.$inferSelect;
type Lead = typeof leads.$inferSelect;
type Hub = { token: string; portal: string };

export { norm };

type Msg = typeof messages.$inferSelect;
/* Leads a message covers and where it goes; older messages cover just their lead */
export const idsOf = (m: Pick<Msg, "leadId" | "leadIds">) => m.leadIds?.length ? m.leadIds : [m.leadId];
const recipients = (m: Pick<Msg, "to">, l: Pick<Lead, "email">) => (m.to || l.email).split(/[,;]\s*/).map(x => x.trim()).filter(Boolean);

async function log(tenantId: number, kind: string, ok: boolean, info: string) {
  await db.insert(runs).values({ tenantId, kind, ok, info: info.slice(0, 500) });
}

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

function focusGroups(prompt: string, k: number) {
  const m = prompt.match(/^Branchen:[ \t]*(.*)$/m);
  const list = (m?.[1] || "").split(/,|;/).map(s => s.trim()).filter(Boolean);
  if (list.length < 2) return [""];
  const groups: string[][] = Array.from({ length: Math.min(k, list.length) }, () => []);
  list.forEach((b, i) => groups[i % groups.length].push(b));
  return groups.map(g => g.join(", "));
}

/* Marsaglia–Tsang; enough for Beta draws with integer counts */
function gamma(k: number): number {
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { const u1 = Math.random(), u2 = Math.random(); x = Math.sqrt(-2 * Math.log(u1 || 1e-12)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
    v = v ** 3; const u = Math.random();
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
const beta = (a: number, b: number) => { const x = gamma(a); return x / (x + gamma(b)); };

/* Thompson sampling: each draft goes to the template whose sampled reply rate is highest.
   New templates get tried, templates with more replies get more of the batch. */
async function pickVariant(tenantId: number) {
  const act = await db.select().from(templates).where(and(eq(templates.tenantId, tenantId), eq(templates.active, true))).orderBy(asc(templates.key));
  if (!act.length) throw new Error("Keine aktive Vorlage");
  const rows = await db.select({ v: messages.variant, sent: sql<number>`count(${messages.sentAt}) - count(${messages.bouncedAt})`.mapWith(Number), replies: sql<number>`count(${messages.repliedAt})`.mapWith(Number) })
    .from(messages).where(eq(messages.tenantId, tenantId)).groupBy(messages.variant);
  const st = Object.fromEntries(act.map(t => { const r = rows.find(x => x.v === t.key); return [t.key, { s: r?.sent ?? 0, r: r?.replies ?? 0 }]; }));
  return () => Object.entries(st).map(([k, x]) => [k, beta(1 + x.r, 1 + Math.max(0, x.s - x.r))] as const).sort((a, b) => b[1] - a[1])[0][0];
}

const FREEMAIL = /@(gmail|googlemail|gmx|web|t-online|outlook|hotmail|live|yahoo|icloud|me|posteo|aol|mail|freenet|online)\.[a-z.]+$/i;

function claimKeys(l: Lead) {
  const domain = l.website ? domainOf(l.website) : l.email && !FREEMAIL.test(l.email) ? l.email.split("@")[1].toLowerCase() : "";
  return [norm(l.company) && `n:${norm(l.company)}`, domain && `d:${domain}`].filter(Boolean) as string[];
}

/* Takes the lead for this tenant before it is drafted: first a claim on the shared portal,
   then the HubSpot check, then the HubSpot record itself. Returns why it is taken, or null. */
async function reserve(t: Tenant, hub: Hub | null, l: Lead): Promise<Known | null> {
  if (!hub || l.hubspotId) return null;
  let claimed = false;
  for (const key of claimKeys(l)) {
    const [mine] = await db.insert(claims).values({ scope: hub.portal, key, tenantId: t.id, leadId: l.id }).onConflictDoNothing().returning();
    if (mine) continue;
    const [other] = await db.select().from(claims).where(and(eq(claims.scope, hub.portal), eq(claims.key, key)));
    if (other && other.tenantId !== t.id) claimed = true;
  }
  const known = await hubspotKnown(hub.token, l.company, l.website, l.email).catch(() => null);
  if (known) return known;
  if (claimed) return { why: "Schon vergeben" };
  try {
    const id = await hubspotReserve(hub.token, l);
    await db.update(leads).set({ hubspotId: id }).where(eq(leads.id, l.id));
    l.hubspotId = id;
  } catch (e) {
    if (e instanceof HubSpotError && e.status === 409) return { why: "Kontakt in HubSpot" };
    await log(t.id, "hubspot", false, `${l.company}: ${(e as Error).message}`);
  }
  return null;
}

/* A company that is taken elsewhere: its contacts go into HubSpot next to it and are not written to */
async function keepAsContact(t: Tenant, hub: Hub | null, row: Lead, companyId: string | undefined, note: string) {
  let stored = false;
  if (hub && companyId && row.email) {
    try { await hubspotAddContact(hub.token, companyId, row); stored = true; }
    catch (e) { stored = e instanceof HubSpotError && e.status === 409; if (!stored) await log(t.id, "hubspot", false, `${row.company}: ${(e as Error).message}`); }
  }
  await db.update(leads).set({ status: "dublette", note, hubspotId: stored ? companyId! : row.hubspotId }).where(eq(leads.id, row.id));
}

/* Evening job: fill today's batch with drafts. Works per company: its open contacts become
   one or several messages, depending on how the company is set to be written to. */
export async function runResearch(t: Tenant, opts: { force?: boolean } = {}) {
  const today = berlinDate();
  const key = await aiFor(t.id);
  if (!key) throw new AiMissing();
  const open = await db.select({ n: sql<number>`count(*)::int` }).from(messages).where(and(eq(messages.tenantId, t.id), eq(messages.batchDate, today)));
  if (open[0].n > 0 && !opts.force) return { created: 0, skipped: "Heute schon recherchiert" };

  const n = Math.max(1, Math.min(30, t.settings.leadsPerDay || 10));
  const token = await hubspotToken(t.id);
  let hub: Hub | null = null;
  if (token) {
    try { hub = { token, portal: await hubspotPortal(token) }; }
    catch (e) { await log(t.id, "hubspot", false, (e as Error).message); }
  }
  const nextVariant = await pickVariant(t.id);
  const jev = await jevKey(t.id);
  await attachCompanies(t.id);
  const known = await db.select({ company: leads.company }).from(leads).where(eq(leads.tenantId, t.id)).orderBy(desc(leads.createdAt)).limit(2000);
  const seen = new Set(known.map(k => norm(k.company)));
  const units: Unit[] = [];
  const done = new Set<number>();

  /* Fills a lead's gaps from the web, unless it already has what the draft needs */
  const enrich = async (l: Lead) => {
    const hasHook = t.tenders ? l.tenders.length > 0 : !!l.hook;
    if (l.email && hasHook) return l;
    try {
      const e = await enrichLead(key, t.settings.prompt, { company: l.company, city: l.city, website: l.website, first: l.first, last: l.last, role: l.role, email: l.email }, t.tenders);
      if (!e) return l;
      const patch = { city: l.city || e.city, website: l.website || e.website, first: l.first || e.first, last: l.last || e.last, salutation: l.salutation || salutationOf(e.salutation),
        role: l.role || e.role, email: l.email || e.email, emailType: l.email ? l.emailType : e.emailType, linkedin: l.linkedin || e.linkedin, hook: l.hook || e.hook, tenders: l.tenders.length ? l.tenders : e.tenders, sourceUrl: l.sourceUrl || e.sourceUrl };
      return (await db.update(leads).set(patch).where(eq(leads.id, l.id)).returning())[0];
    } catch (err) { await log(t.id, "enrich", false, `${l.company}: ${(err as Error).message}`); return l; }
  };

  /* All open contacts of one company: reserve it once, then plan its messages */
  const admit = async (companyId: number) => {
    if (done.has(companyId)) return;
    done.add(companyId);
    const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
    const all = await db.select().from(leads).where(and(eq(leads.companyId, companyId), eq(leads.tenantId, t.id))).orderBy(asc(leads.id));
    let rows = await pool(all.filter(l => l.status === "neu"), 4, enrich);
    /* without any address at the company and without LinkedIn nobody can be written to */
    if (!rows.some(l => l.email) && !all.some(l => l.email)) {
      for (const l of rows.filter(l => !l.linkedin)) await db.update(leads).set({ note: l.note || "E-Mail fehlt" }).where(eq(leads.id, l.id));
      rows = rows.filter(l => l.linkedin);
    }
    if (!rows.length) return;
    /* salutation from first name and role where Jev is sure, so {{anrede}} can name the person */
    const unsure = rows.filter(l => l.last && !l.salutation);
    if (jev && unsure.length) {
      const g = await guessSalutations(jev, unsure.map(l => ({ first: l.first, last: l.last, role: l.role }))).catch(() => []);
      for (const [k, l] of unsure.entries()) if (g[k]) { l.salutation = g[k]; await db.update(leads).set({ salutation: g[k] }).where(eq(leads.id, l.id)); }
    }
    /* a company this tenant already works with is in HubSpot already; new contacts are added there */
    const ours = all.find(l => l.hubspotId && l.status !== "dublette");
    if (hub && ours) {
      for (const l of rows.filter(l => !l.hubspotId && l.email)) {
        try { await hubspotAddContact(hub.token, ours.hubspotId, l); await db.update(leads).set({ hubspotId: ours.hubspotId }).where(eq(leads.id, l.id)); }
        catch (e) { if (!(e instanceof HubSpotError && e.status === 409)) await log(t.id, "hubspot", false, `${l.company}: ${(e as Error).message}`); }
      }
    } else if (hub) {
      const taken = await reserve(t, hub, rows[0]);
      if (taken) { for (const l of rows) await keepAsContact(t, hub, l, taken.companyId, taken.why); return; }
      for (const l of rows.slice(1).filter(l => l.email && rows[0].hubspotId)) {
        try { await hubspotAddContact(hub.token, rows[0].hubspotId, l); await db.update(leads).set({ hubspotId: rows[0].hubspotId }).where(eq(leads.id, l.id)); }
        catch (e) { if (!(e instanceof HubSpotError && e.status === 409)) await log(t.id, "hubspot", false, `${l.company}: ${(e as Error).message}`); }
      }
    }
    units.push(...plan(c, rows, all.map(l => l.email)));
  };

  /* 1. imported leads first, company by company in list order */
  const queue = await db.select({ companyId: leads.companyId }).from(leads).where(and(eq(leads.tenantId, t.id), eq(leads.status, "neu"))).orderBy(asc(leads.createdAt), asc(leads.id));
  for (const q of queue) { if (units.length >= n) break; if (q.companyId) await admit(q.companyId); }

  /* 2. new research for the rest; asks for a few extra so duplicates can be replaced,
     and whatever is left over waits in the list for the next evening */
  const rest = n - units.length;
  if (rest > 0) {
    const want = rest + Math.ceil(rest / 2);
    const groups = focusGroups(t.settings.prompt, want >= 6 ? 3 : want >= 3 ? 2 : 1);
    const per = Math.ceil(want / groups.length);
    const results = await Promise.allSettled(groups.map(g => researchLeads(key, t.settings.prompt, per, known.map(k => k.company), g, t.tenders)));
    const found: LeadOut[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") found.push(...r.value);
      else await log(t.id, "research", false, r.reason?.message || String(r.reason));
    }
    /* several people of one company arrive as several entries with the same company name */
    const fresh = new Set<string>();
    for (const f of found) {
      const k = norm(f.company);
      if (!k || (seen.has(k) && !fresh.has(k))) continue;
      seen.add(k); fresh.add(k);
      await db.insert(leads).values({ tenantId: t.id, ...f, salutation: salutationOf(f.salutation), source: "Claude-Recherche", status: "neu" });
    }
    await attachCompanies(t.id);
    const added = await db.select({ companyId: leads.companyId }).from(leads).where(and(eq(leads.tenantId, t.id), eq(leads.status, "neu"))).orderBy(asc(leads.createdAt), asc(leads.id));
    for (const q of added) { if (units.length >= n) break; if (q.companyId) await admit(q.companyId); }
  }

  /* 3. drafts */
  for (const u of units) {
    const ids = u.leads.map(l => l.id);
    await db.insert(messages).values({ tenantId: t.id, leadId: ids[0], leadIds: ids, to: u.to.join(", "), batchDate: today, variant: nextVariant(), channel: u.to.length ? "mail" : "linkedin" });
    await db.update(leads).set({ status: "freigabe" }).where(inArray(leads.id, ids));
  }
  await log(t.id, "research", true, `${units.length} Entwürfe`);
  return { created: units.length };
}

export async function approvalMail(t: Tenant) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(messages).where(and(eq(messages.tenantId, t.id), eq(messages.status, "entwurf")));
  if (!n) return;
  const url = process.env.APP_URL || "";
  const all = await db.select({ email: users.email, short: users.short }).from(users).innerJoin(members, eq(members.userId, users.id)).where(eq(members.tenantId, t.id));
  for (const u of all) {
    await sendSystem(t.id, { to: u.email, subject: `${n} Entwürfe für ${t.name} warten auf Freigabe`,
      text: `Hallo ${u.short},\n\nfür morgen früh liegen ${n} Nachrichten zur Freigabe bereit.\n\n${url}/#freigabe\n\nVersand um 08:00.` });
  }
}

/* Morning job: send everything that was approved */
export async function sendApproved(t: Tenant) {
  const rows = await db.select({ m: messages, l: leads }).from(messages).innerJoin(leads, eq(leads.id, messages.leadId))
    .where(and(eq(messages.tenantId, t.id), eq(messages.status, "freigegeben"), eq(messages.channel, "mail"), isNotNull(messages.senderId)));
  const hub = await hubspotToken(t.id);
  let sent = 0, failed = 0;
  for (const { m, l } of rows) {
    try {
      const to = recipients(m, l);
      if (!to.length) throw new Error("E-Mail fehlt");
      await sendAs(t.id, m.senderId!, { to: to.join(", "), subject: m.finalSubject || "", text: m.finalBody || "" });
      const covered = await db.select().from(leads).where(inArray(leads.id, idsOf(m)));
      let hs = covered.every(x => !!x.hubspotId);
      if (hub && !hs) {
        for (const x of covered.filter(x => !x.hubspotId && x.email)) { try { await hubspotCreateContact(hub, x); } catch { /* already there or no scope */ } }
        hs = true;
      }
      await db.update(messages).set({ status: "gesendet", sentAt: new Date(), error: "", hubspot: hs }).where(eq(messages.id, m.id));
      await db.update(leads).set({ status: "angeschrieben" }).where(inArray(leads.id, idsOf(m)));
      sent++;
    } catch (e) {
      failed++;
      await db.update(messages).set({ error: (e as Error).message.slice(0, 300) }).where(eq(messages.id, m.id));
    }
  }
  await log(t.id, "send", failed === 0, `${sent} gesendet${failed ? `, ${failed} fehlgeschlagen` : ""}`);

  /* Jev's view of what actually went out, to check later whether its scores predict replies */
  const scoreKey = await jevKey(t.id);
  if (scoreKey) {
    for (const { m, l } of rows) {
      try {
        const score = await scoreMail(scoreKey, { subject: m.finalSubject || "", body: m.finalBody || "", company: l.company, role: l.role }, { wait: false });
        await db.update(messages).set({ score }).where(and(eq(messages.id, m.id), eq(messages.status, "gesendet")));
      } catch (e) { if (e instanceof JevLimit) break; }
    }
  }
  return { sent, failed };
}

export async function checkReplies(t: Tenant) {
  const since = new Date(Date.now() - 45 * 864e5);
  const rows = await db.select({ m: messages, l: leads }).from(messages).innerJoin(leads, eq(leads.id, messages.leadId))
    .where(and(eq(messages.tenantId, t.id), eq(messages.status, "gesendet"), gte(messages.sentAt, since)));
  let found = 0;
  for (const { m, l } of rows) {
    let r = false;
    for (const a of recipients(m, l)) if (await hasReply(t.id, m.senderId!, a, m.sentAt!).catch(() => null)) { r = true; break; }
    if (r) {
      await db.update(messages).set({ status: "beantwortet", repliedAt: new Date() }).where(eq(messages.id, m.id));
      await db.update(leads).set({ status: "beantwortet" }).where(inArray(leads.id, idsOf(m)));
      found++;
    }
  }
  return found;
}

export async function setLeadStatus(tenantId: number, leadId: number, status: string) {
  await db.update(leads).set({ status }).where(and(eq(leads.id, leadId), eq(leads.tenantId, tenantId)));
  const [m] = await db.select().from(messages).where(and(or(eq(messages.leadId, leadId), sql`${messages.leadIds} @> ${JSON.stringify([leadId])}::jsonb`), inArray(messages.status, ["gesendet", "beantwortet", "unzustellbar"]))).orderBy(desc(messages.sentAt)).limit(1);
  if (!m) return;
  if (status === "beantwortet") await db.update(messages).set({ status, repliedAt: m.repliedAt || new Date() }).where(eq(messages.id, m.id));
  else if (status === "unzustellbar") await db.update(messages).set({ status, bouncedAt: new Date(), repliedAt: null }).where(eq(messages.id, m.id));
  else if (status === "angeschrieben") await db.update(messages).set({ status: "gesendet", repliedAt: null, bouncedAt: null }).where(eq(messages.id, m.id));
}

export async function lastRuns(tenantId: number) {
  return db.select().from(runs).where(eq(runs.tenantId, tenantId)).orderBy(desc(runs.createdAt)).limit(8);
}
