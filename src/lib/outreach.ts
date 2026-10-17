import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { claims, db, leads, members, messages, runs, templates, tenants, users } from "@/db";
import { berlinDate } from "./dates";
import { getInteg } from "./integrations";
import { enrichLead, researchLeads, type LeadOut } from "./claude";
import { aiFor } from "./ai";
import { HubSpotError, domainOf, hubspotAddContact, hubspotCreateContact, hubspotKnown, hubspotPortal, hubspotReserve, hubspotToken, type Known } from "./hubspot";
import { hasReply, sendAs, sendSystem } from "./mail";
import { JevLimit, scoreMail } from "./jev";

type Tenant = typeof tenants.$inferSelect;
type Lead = typeof leads.$inferSelect;
type Hub = { token: string; portal: string };

export const norm = (s: string) => s.toLowerCase().replace(/gmbh\s*&\s*co\.?\s*kg|gmbh|ag|kg|se|e\.k\.|ug|\(haftungsbeschränkt\)|[^a-z0-9äöüß]/g, "");

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

/* One person per company is written to. Further addresses at that company go into HubSpot next to it. */
async function keepAsContact(t: Tenant, hub: Hub | null, row: Lead, companyId: string | undefined, note: string) {
  let stored = false;
  if (hub && companyId && row.email) {
    try { await hubspotAddContact(hub.token, companyId, row); stored = true; }
    catch (e) { stored = e instanceof HubSpotError && e.status === 409; if (!stored) await log(t.id, "hubspot", false, `${row.company}: ${(e as Error).message}`); }
  }
  await db.update(leads).set({ status: "dublette", note, hubspotId: stored ? companyId! : row.hubspotId }).where(eq(leads.id, row.id));
}

/* Evening job: fill today's batch with drafts */
export async function runResearch(t: Tenant, opts: { force?: boolean } = {}) {
  const today = berlinDate();
  const key = await aiFor(t.id);
  if (!key) throw new Error("Keine KI verbunden");
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
  const known = await db.select({ company: leads.company }).from(leads).where(eq(leads.tenantId, t.id)).orderBy(desc(leads.createdAt)).limit(2000);
  const seen = new Set(known.map(k => norm(k.company)));
  const ready: Lead[] = [];

  /* Companies this tenant already writes to, by name and domain */
  const taken = new Map<string, Lead>();
  const busy = await db.select().from(leads).where(and(eq(leads.tenantId, t.id), inArray(leads.status, ["freigabe", "angeschrieben", "beantwortet", "unzustellbar"])));
  const take = (l: Lead) => { for (const k of claimKeys(l)) if (!taken.has(k)) taken.set(k, l); };
  busy.forEach(take);
  const ownedBy = (l: Lead) => claimKeys(l).map(k => taken.get(k)).find(Boolean);

  /* Takes the lead into the batch, or marks why not. Runs one at a time so the batch never overshoots. */
  const admit = async (row: Lead) => {
    const first = ownedBy(row);
    if (first) { await keepAsContact(t, hub, row, first.hubspotId || undefined, `Weiterer Kontakt, angeschrieben wird ${[first.first, first.last].filter(Boolean).join(" ") || first.email}`); return; }
    if (!row.email && !row.linkedin) { await db.update(leads).set({ note: "E-Mail fehlt" }).where(eq(leads.id, row.id)); return; }
    const known = await reserve(t, hub, row);
    if (known) { await keepAsContact(t, hub, row, known.companyId, known.why); return; }
    ready.push(row); take(row);
  };

  /* 1. imported leads first, in list order; a duplicate makes room for the next one */
  const queue = await db.select().from(leads).where(and(eq(leads.tenantId, t.id), eq(leads.status, "neu"))).orderBy(asc(leads.createdAt), asc(leads.id));
  for (let next = 0; ready.length < n && next < queue.length;) {
    const chunk = queue.slice(next, next += n - ready.length);
    const rows = await pool(chunk, 4, async l => {
      if (ownedBy(l) || (l.email && (!t.tenders || l.tenders.length))) return l;
      try {
        const e = await enrichLead(key, t.settings.prompt, { company: l.company, city: l.city, website: l.website, first: l.first, last: l.last, role: l.role, email: l.email }, t.tenders);
        if (!e) return l;
        const patch = { city: l.city || e.city, website: l.website || e.website, first: l.first || e.first, last: l.last || e.last, salutation: l.salutation || e.salutation,
          role: l.role || e.role, email: l.email || e.email, emailType: l.email ? l.emailType : e.emailType, linkedin: l.linkedin || e.linkedin, hook: l.hook || e.hook, tenders: l.tenders.length ? l.tenders : e.tenders };
        return (await db.update(leads).set(patch).where(eq(leads.id, l.id)).returning())[0];
      } catch (err) { await log(t.id, "enrich", false, `${l.company}: ${(err as Error).message}`); return l; }
    });
    for (const row of rows) await admit(row);
  }

  /* 2. new research for the rest; asks for a few extra so duplicates can be replaced,
     and whatever is left over waits in the list for the next evening */
  const rest = n - ready.length;
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
    for (const f of found) {
      const k = norm(f.company);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const sal = /^frau/i.test(f.salutation) ? "Frau" : /^herr/i.test(f.salutation) ? "Herr" : "";
      const [row] = await db.insert(leads).values({ tenantId: t.id, ...f, salutation: sal, source: "Claude-Recherche", status: "neu" }).returning();
      if (ready.length < n) await admit(row);
    }
  }

  /* 3. drafts */
  for (const l of ready) {
    await db.insert(messages).values({ tenantId: t.id, leadId: l.id, batchDate: today, variant: nextVariant(), channel: l.email ? "mail" : "linkedin" });
    await db.update(leads).set({ status: "freigabe" }).where(eq(leads.id, l.id));
  }
  await log(t.id, "research", true, `${ready.length} Entwürfe`);
  return { created: ready.length };
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
      if (!l.email) throw new Error("E-Mail fehlt");
      await sendAs(t.id, m.senderId!, { to: l.email, subject: m.finalSubject || "", text: m.finalBody || "" });
      let hs = !!l.hubspotId;
      if (hub && !hs) { try { await hubspotCreateContact(hub, l); hs = true; } catch { /* already there or no scope */ } }
      await db.update(messages).set({ status: "gesendet", sentAt: new Date(), error: "", hubspot: hs }).where(eq(messages.id, m.id));
      await db.update(leads).set({ status: "angeschrieben" }).where(eq(leads.id, l.id));
      sent++;
    } catch (e) {
      failed++;
      await db.update(messages).set({ error: (e as Error).message.slice(0, 300) }).where(eq(messages.id, m.id));
    }
  }
  await log(t.id, "send", failed === 0, `${sent} gesendet${failed ? `, ${failed} fehlgeschlagen` : ""}`);

  /* Jev's view of what actually went out, to check later whether its scores predict replies */
  const jev = (await getInteg(t.id, "jev"))?.key;
  if (jev) {
    for (const { m, l } of rows) {
      try {
        const score = await scoreMail(jev, { subject: m.finalSubject || "", body: m.finalBody || "", company: l.company, role: l.role }, { wait: false });
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
    const r = await hasReply(t.id, m.senderId!, l.email, m.sentAt!).catch(() => null);
    if (r) {
      await db.update(messages).set({ status: "beantwortet", repliedAt: new Date() }).where(eq(messages.id, m.id));
      await db.update(leads).set({ status: "beantwortet" }).where(eq(leads.id, l.id));
      found++;
    }
  }
  return found;
}

export async function setLeadStatus(tenantId: number, leadId: number, status: string) {
  await db.update(leads).set({ status }).where(and(eq(leads.id, leadId), eq(leads.tenantId, tenantId)));
  const [m] = await db.select().from(messages).where(and(eq(messages.leadId, leadId), inArray(messages.status, ["gesendet", "beantwortet", "unzustellbar"]))).orderBy(desc(messages.sentAt)).limit(1);
  if (!m) return;
  if (status === "beantwortet") await db.update(messages).set({ status, repliedAt: m.repliedAt || new Date() }).where(eq(messages.id, m.id));
  else if (status === "unzustellbar") await db.update(messages).set({ status, bouncedAt: new Date(), repliedAt: null }).where(eq(messages.id, m.id));
  else if (status === "angeschrieben") await db.update(messages).set({ status: "gesendet", repliedAt: null, bouncedAt: null }).where(eq(messages.id, m.id));
}

export async function lastRuns(tenantId: number) {
  return db.select().from(runs).where(eq(runs.tenantId, tenantId)).orderBy(desc(runs.createdAt)).limit(8);
}
