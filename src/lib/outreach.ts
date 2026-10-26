import { and, asc, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { blockedAddresses, suppressEmail } from "./suppress";
import { claims, companies, db, leads, members, messages, runs, templates, tenants, users } from "@/db";
import { attachCompanies, norm, plan, type Unit } from "./companies";
import { salutationOf } from "./lead-fields";
import { berlinDate } from "./dates";
import { getInteg } from "./integrations";
import { enrichLead } from "./claude";
import { AiMissing, aiFor } from "./ai";
import { HubSpotError, domainOf, hubspotAddContact, hubspotCreateContact, hubspotKnown, hubspotPortal, hubspotReserve, hubspotToken, type Known } from "./hubspot";
import { hasReply, sendAs, sendSystem } from "./mail";
import { JevLimit, guessSalutations, jevKey } from "./jev";
import { judge, scoreDrafts, templateStats } from "./drafts";
import { refreshRatings, rerate } from "./ratings";
import { researchRound } from "./strategy";
import { beta } from "./angles";
import { FREEMAIL, channelOf } from "./lead-rating";
import { bouncedDomains, byCompany, draftPlan, linkedinOn, liQueue, mailQueue, perDay, roomTonight, sentToday, type QueueLead } from "./queue";
import { sendpilotPush } from "./sendpilot";
import { DAY_NAMES, draftDay, hh, isoWeekday, planOf, sendQuota } from "./schedule";
import { track } from "./usage";

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

/* Runs fn over items with at most `size` at a time, results in input order */
export async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

/* Thompson sampling: each draft goes to the template whose sampled reply rate is highest.
   The prior (worth 20 sends) comes from the template's score, so a well-scored new template gets tried more; replies take over. */
async function pickVariant(tenantId: number) {
  const act = await db.select().from(templates).where(and(eq(templates.tenantId, tenantId), eq(templates.active, true))).orderBy(asc(templates.key));
  if (!act.length) throw new Error("Keine aktive Vorlage");
  const all = await templateStats(tenantId);
  const st = act.map(t => [t.key, all[t.key]] as const);
  return () => st.map(([k, x]) => [k, beta(1 + x.replies + 20 * x.prior, 1 + Math.max(0, x.sent - x.replies) + 20 * (1 - x.prior))] as const).sort((a, b) => b[1] - a[1])[0][0];
}


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
export const runResearch = (t: Tenant, opts: { force?: boolean } = {}) => track({ tenantId: t.id, kind: "recherche" }, async m => {
  const r = await research(t, opts);
  m.count(r.created);
  return r;
});

async function research(t: Tenant, opts: { force?: boolean }) {
  const today = berlinDate();
  const key = await aiFor(t.id);
  if (!key) throw new AiMissing();
  const open = await db.select({ n: sql<number>`count(*)::int` }).from(messages).where(and(eq(messages.tenantId, t.id), eq(messages.batchDate, today)));
  if (open[0].n > 0 && !opts.force) return { created: 0, skipped: "Heute schon recherchiert" };

  /* leadsPerDay per send day: drafts still waiting for that day take part of it */
  const perLi = perDay(t), n = await roomTonight(t);
  const token = await hubspotToken(t.id);
  let hub: Hub | null = null;
  if (token) {
    try { hub = { token, portal: await hubspotPortal(token) }; }
    catch (e) { await log(t.id, "hubspot", false, (e as Error).message); }
  }
  const nextVariant = await pickVariant(t.id);
  const jev = await jevKey(t.id);
  await attachCompanies(t.id);
  const units: Unit[] = [];
  const onLi = await linkedinOn(t.id), bounced = onLi ? await bouncedDomains(t.id) : [];
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

  /* The open contacts of one company (only those in `only`, when a company has more than a day takes): reserve it once, then plan its messages */
  const admit = async (companyId: number, only: number[]) => {
    if (done.has(companyId)) return;
    done.add(companyId);
    const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
    const all = await db.select().from(leads).where(and(eq(leads.companyId, companyId), eq(leads.tenantId, t.id))).orderBy(asc(leads.id));
    /* a company already reached on LinkedIn is not mailed; with SendPilot on, LinkedIn contacts go there instead */
    if (all.some(l => l.sendpilotAt)) return;
    let rows = await pool(all.filter(l => l.status === "neu" && only.includes(l.id) && !(onLi && channelOf(l, bounced).ch === "linkedin")), 4, enrich);
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
    units.push(...plan(c, rows, all.filter(l => l.status !== "papierkorb").map(l => l.email)));
  };

  /* 1. open leads first, in the order of the send queue (drag and drop, then rating); replies come most often on Tuesday and Wednesday
     (6,337 cold mails), so with holdTop grade-A leads wait for those days and only fill the batch on other days when nothing else is left */
  await refreshRatings(t.id).catch(e => log(t.id, "rating", false, (e as Error).message));
  await toLinkedin(t, perLi);
  /* n people per evening; a company whose contacts no longer fit waits for the next one, one bigger than a whole evening sends its first n, as the lead list shows it */
  const taken = () => units.reduce((s, u) => s + u.leads.length, 0);
  const fill = async (q: QueueLead[], stopAtHeld: boolean) => {
    for (const g of byCompany(q)) {
      if ((stopAtHeld && g.held) || taken() >= n || (taken() > 0 && taken() + g.ids.length > n)) break;
      if (g.companyId) await admit(g.companyId, g.ids.slice(0, n));
    }
  };
  await fill(await mailQueue(t), true);

  /* 2. new research for the rest along the strategy's directions; asks for a few extra so duplicates can be replaced,
     and whatever is left over waits in the list, rated, for the next evening */
  const rest = n - taken();
  if (rest > 0) {
    await researchRound(t, rest + Math.ceil(rest / 2), key);
    await refreshRatings(t.id).catch(e => log(t.id, "rating", false, (e as Error).message));
    await fill(await mailQueue(t), false);
  }

  /* 3. drafts, each scored before anyone reads it */
  const made: number[] = [];
  for (const u of units) {
    const ids = u.leads.map(l => l.id);
    const [m] = await db.insert(messages).values({ tenantId: t.id, leadId: ids[0], leadIds: ids, to: u.to.join(", "), batchDate: today, variant: nextVariant(), channel: u.to.length ? "mail" : "linkedin" }).returning({ id: messages.id });
    made.push(m.id);
    await db.update(leads).set({ status: "freigabe" }).where(inArray(leads.id, ids));
  }
  await scoreDrafts(t.id, made).catch(e => log(t.id, "score", false, (e as Error).message));
  await log(t.id, "research", true, `${units.length} Entwürfe`);
  return { created: units.length };
}

/* LinkedIn leads into the tenant's SendPilot campaign, the best n per evening; without a campaign they wait for the LinkedIn button */
async function toLinkedin(t: Tenant, n: number) {
  const ids = (await liQueue(t)).slice(0, n);
  if (!ids.length) return;
  try { const r = await sendpilotPush(t.id, t.settings.sendpilotCampaign!, ids); await log(t.id, "linkedin", true, `${r.added} an SendPilot`); }
  catch (e) { await log(t.id, "linkedin", false, (e as Error).message); }
}

export async function approvalMail(t: Tenant) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(messages).where(and(eq(messages.tenantId, t.id), eq(messages.status, "entwurf")));
  if (!n) return;
  const url = process.env.APP_URL || "";
  const p = planOf(t.settings), day = draftDay(p, berlinDate());
  const when = `${DAY_NAMES[isoWeekday(day) - 1]} ${day.slice(8)}.${day.slice(5, 7)}. zwischen ${hh(p.from)} und ${hh(p.to)}`;
  const all = await db.select({ email: users.email, short: users.short }).from(users).innerJoin(members, eq(members.userId, users.id)).where(eq(members.tenantId, t.id));
  for (const u of all) {
    await sendSystem(t.id, { to: u.email, subject: `${n} Entwürfe für ${t.name} warten auf Freigabe`,
      text: `Hallo ${u.short},\n\n${n} Nachrichten liegen zur Freigabe bereit.\n\n${url}/#freigabe\n\nVersand ${when}.` });
  }
}

/* Hourly in the tenant's send window: an even share of what was approved, the rest in the last hour; now = everything at once (button) */
export async function sendApproved(t: Tenant, opts: { now?: boolean } = {}) {
  let rows = await db.select({ m: messages, l: leads }).from(messages).innerJoin(leads, eq(leads.id, messages.leadId))
    .where(and(eq(messages.tenantId, t.id), eq(messages.status, "freigegeben"), eq(messages.channel, "mail"), isNotNull(messages.senderId)))
    .orderBy(sql`${messages.error} <> ''`, sql`coalesce(${messages.sendRank}, 0)`, asc(messages.id));
  if (!opts.now) {
    /* a draft pushed behind waits for its own day instead of filling today's room */
    if (rows.some(({ m }) => (m.sendRank ?? 0) > 0)) {
      const { byMsg, today } = await draftPlan(t);
      rows = rows.filter(({ m }) => (m.sendRank ?? 0) <= 0 || (byMsg[m.id] ?? today) <= today);
    }
    /* at most leadsPerDay people a day; the rest goes out on the next send day */
    let room = perDay(t) - await sentToday(t.id);
    rows = rows.filter(({ m }) => { const k = idsOf(m).length; if (k > room && room < perDay(t)) { room = 0; return false; } room -= k; return true; });
    rows = rows.slice(0, sendQuota(planOf(t.settings), rows.length));
  }
  if (!rows.length) return { sent: 0, failed: 0 };
  const hub = await hubspotToken(t.id);
  let sent = 0, failed = 0;
  for (const { m, l } of rows) {
    /* two ticks in the same hour must not send one message twice */
    const [mine] = await db.update(messages).set({ status: "versand" }).where(and(eq(messages.id, m.id), eq(messages.status, "freigegeben"))).returning({ id: messages.id });
    if (!mine) continue;
    let out = false;
    try {
      const to = recipients(m, l);
      if (!to.length) throw new Error("E-Mail fehlt");
      /* the block list wins over an approval given before the address landed on it */
      const stop = await blockedAddresses(t.id, to);
      if (stop.length) { await db.update(messages).set({ status: "gesperrt", error: `Gesperrt: ${stop.join(", ")}` }).where(eq(messages.id, m.id)); continue; }
      await sendAs(t.id, m.senderId!, { to: to.join(", "), subject: m.finalSubject || "", text: m.finalBody || "" });
      out = true;
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
      await db.update(messages).set({ status: out ? "gesendet" : "freigegeben", ...(out ? { sentAt: new Date() } : {}), error: (e as Error).message.slice(0, 300) }).where(eq(messages.id, m.id));
    }
  }
  await log(t.id, "send", failed === 0, `${sent} gesendet${failed ? `, ${failed} fehlgeschlagen` : ""}`);

  /* the score of what actually went out, to calibrate scores against replies; unchanged text keeps its score */
  const scoreKey = await jevKey(t.id);
  if (scoreKey) {
    for (const { m, l } of rows) {
      try {
        const score = await judge(scoreKey, { subject: m.finalSubject || "", body: m.finalBody || "" }, l, m.score, null, false);
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
  if (found) await rerate(t.id).catch(e => console.error("rating", t.slug, e));
  return found;
}

export async function setLeadStatus(tenantId: number, leadId: number, status: string) {
  await db.update(leads).set({ status }).where(and(eq(leads.id, leadId), eq(leads.tenantId, tenantId)));
  /* an address that bounced goes on the block list, so no other run or sequence tries it again */
  if (status === "unzustellbar") { const [l] = await db.select({ email: leads.email }).from(leads).where(and(eq(leads.id, leadId), eq(leads.tenantId, tenantId))); if (l?.email) await suppressEmail(tenantId, l.email, "unzustellbar"); }
  const [m] = await db.select().from(messages).where(and(or(eq(messages.leadId, leadId), sql`${messages.leadIds} @> ${JSON.stringify([leadId])}::jsonb`), inArray(messages.status, ["gesendet", "beantwortet", "unzustellbar"]))).orderBy(desc(messages.sentAt)).limit(1);
  if (!m) return;
  if (status === "beantwortet") await db.update(messages).set({ status, repliedAt: m.repliedAt || new Date() }).where(eq(messages.id, m.id));
  else if (status === "unzustellbar") await db.update(messages).set({ status, bouncedAt: new Date(), repliedAt: null }).where(eq(messages.id, m.id));
  else if (status === "angeschrieben") await db.update(messages).set({ status: "gesendet", repliedAt: null, bouncedAt: null }).where(eq(messages.id, m.id));
}

export async function lastRuns(tenantId: number) {
  return db.select().from(runs).where(eq(runs.tenantId, tenantId)).orderBy(desc(runs.createdAt)).limit(8);
}
