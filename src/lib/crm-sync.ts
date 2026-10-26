import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { companies, crmSyncs, db, leads, messages, tenants } from "@/db";
import { attachCompanies, norm } from "./companies";
import { domainOf, hubspotCompaniesRead, hubspotContactsChanged, hubspotToken, type HsContact } from "./hubspot";
import { emailTypeOf, httpUrl, salutationOf } from "./lead-fields";
import { suppress } from "./suppress";

type Tenant = typeof tenants.$inferSelect;
type Sync = typeof crmSyncs.$inferSelect;

/* HubSpot leads: registrations on the website land in HubSpot; Sales Monster mirrors them as CRM contacts and never cold-mails them */
const PROPS = ["email", "firstname", "lastname", "salutation", "company", "jobtitle", "phone", "mobilephone", "website", "city", "lifecyclestage", "createdate", "lastmodifieddate", "associatedcompanyid", "hs_email_optout"];
const CO_PROPS = ["name", "domain", "website", "city"];
/* a step reads pages until this much time is used, so a cron run or a click never runs into the function limit */
const BUDGET = 40_000, LOCK = 120_000;

export async function crmSyncOf(tenantId: number) {
  return (await db.select().from(crmSyncs).where(eq(crmSyncs.tenantId, tenantId)))[0] ?? null;
}

/* Which HubSpot property marks a registration; a new rule reads all contacts again */
export async function setCrmRule(tenantId: number, property: string, value: string) {
  property = property.trim(); value = value.trim();
  const cur = await crmSyncOf(tenantId);
  const changed = !cur || cur.property !== property || cur.value !== value;
  const set = { property, value, ...(changed ? { cursor: "", imported: 0, updated: 0, error: "" } : {}), status: property ? "bereit" : "aus", updatedAt: new Date() };
  await db.insert(crmSyncs).values({ tenantId, ...set }).onConflictDoUpdate({ target: crmSyncs.tenantId, set });
  return crmSyncOf(tenantId);
}

/* when the property holds a date (e.g. signup_datum) that is the registration, else when the contact was created */
function registeredAt(c: HsContact, property: string) {
  const v = c.properties[property], d = v && /^\d{4}-\d{2}-\d{2}/.test(v) ? Date.parse(v) : NaN;
  return new Date(Number.isFinite(d) ? d : Date.parse(c.properties.createdate || "") || Date.now());
}

const p = (c: HsContact, k: string) => (c.properties[k] || "").trim();

/* One page of HubSpot contacts into leads: matched by HubSpot id, else by address; companies by HubSpot id, else by domain, else by name */
export async function fileContacts(tenantId: number, property: string, list: HsContact[], token: string | null) {
  const contacts = list.filter(c => p(c, "email") || p(c, "firstname") || p(c, "lastname"));
  if (!contacts.length) return { imported: 0, updated: 0 };
  const ids = contacts.map(c => String(c.id)), emails = contacts.map(c => p(c, "email").toLowerCase()).filter(Boolean);
  const have = await db.select().from(leads).where(and(eq(leads.tenantId, tenantId),
    or(inArray(leads.hsContactId, ids), emails.length ? inArray(sql`lower(${leads.email})`, emails) : undefined)));
  const byHs = new Map(have.filter(l => l.hsContactId).map(l => [l.hsContactId, l])), byMail = new Map(have.filter(l => l.email).map(l => [l.email.toLowerCase(), l]));

  /* the companies HubSpot associates, read once per page */
  const coIds = [...new Set(contacts.map(c => p(c, "associatedcompanyid")).filter(Boolean))];
  const hsCos = token && coIds.length ? await hubspotCompaniesRead(token, coIds, CO_PROPS).catch(() => []) : [];
  const coById = new Map<string, number>();
  if (coIds.length) {
    const known = await db.select({ id: companies.id, hubspotId: companies.hubspotId }).from(companies).where(and(eq(companies.tenantId, tenantId), inArray(companies.hubspotId, coIds)));
    for (const c of known) coById.set(c.hubspotId, c.id);
  }
  for (const hc of hsCos) {
    const hid = String(hc.id);
    if (coById.has(hid)) continue;
    const name = p(hc, "name") || p(hc, "domain"), domain = domainOf(p(hc, "domain") || p(hc, "website"));
    const key = norm(name) || `hs-${hid}`;
    /* the same company may be there already from research or the mailbox, under its domain or name */
    const [same] = await db.select({ id: companies.id, hubspotId: companies.hubspotId }).from(companies)
      .where(and(eq(companies.tenantId, tenantId), domain ? or(eq(companies.domain, domain), eq(companies.key, key)) : eq(companies.key, key))).limit(1);
    if (same) {
      if (!same.hubspotId) await db.update(companies).set({ hubspotId: hid, ...(domain ? { domain } : {}) }).where(eq(companies.id, same.id));
      coById.set(hid, same.id);
      continue;
    }
    const [c] = await db.insert(companies).values({ tenantId, key, name: name || "–", hubspotId: hid, domain }).onConflictDoNothing().returning({ id: companies.id });
    if (c) coById.set(hid, c.id);
  }
  const coName = new Map(hsCos.map(c => [String(c.id), p(c, "name")]));

  let updated = 0;
  const fresh: (typeof leads.$inferInsert)[] = [], stopped: number[] = [];
  for (const c of contacts) {
    const email = p(c, "email"), hid = String(c.id), coHs = p(c, "associatedcompanyid");
    const fields = { first: p(c, "firstname"), last: p(c, "lastname"), role: p(c, "jobtitle"), phone: p(c, "phone") || p(c, "mobilephone"),
      website: httpUrl(p(c, "website")), city: p(c, "city"), salutation: salutationOf(p(c, "salutation")) };
    const company = coName.get(coHs) || p(c, "company"), companyId = coById.get(coHs) ?? null;
    const crm = { hsContactId: hid, stage: p(c, "lifecyclestage") };
    const l = byHs.get(hid) || (email ? byMail.get(email.toLowerCase()) : undefined);
    if (l) {
      /* HubSpot leads: its values win, empty ones keep what the portal knows */
      const set: Partial<typeof leads.$inferInsert> = { ...crm, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v)) };
      if (!l.crmAt) set.crmAt = registeredAt(c, property);
      if (email && !l.email) set.email = email;
      if (companyId && l.companyId !== companyId) { set.companyId = companyId; if (company) set.company = company; }
      /* someone who registered is not written to cold any more */
      if (l.status === "neu" || l.status === "freigabe") { set.status = "kontakt"; stopped.push(l.id); }
      await db.update(leads).set(set).where(eq(leads.id, l.id));
      updated++;
    } else {
      fresh.push({ tenantId, ...fields, ...crm, company, companyId, email, emailType: emailTypeOf(email, !!(fields.first || fields.last)),
        source: "HubSpot", status: "kontakt", prospect: false, crmAt: registeredAt(c, property) });
    }
  }
  /* drafts not sent yet for people who registered meanwhile */
  if (stopped.length) await db.delete(messages).where(and(eq(messages.tenantId, tenantId), isNull(messages.sentAt), inArray(messages.status, ["entwurf", "freigegeben"]),
    or(inArray(messages.leadId, stopped), ...stopped.map(id => sql`${messages.leadIds} @> ${JSON.stringify([id])}::jsonb`))));
  for (let i = 0; i < fresh.length; i += 500) await db.insert(leads).values(fresh.slice(i, i + 500)).onConflictDoNothing();
  /* who opted out of mail in HubSpot is on the block list here too */
  const out = contacts.filter(c => p(c, "hs_email_optout") === "true" && p(c, "email")).map(c => ({ kind: "email" as const, value: p(c, "email").toLowerCase() }));
  if (out.length) await suppress(tenantId, out, "hubspot");
  /* people without a HubSpot company are grouped by company name like every other lead */
  if (fresh.some(f => !f.companyId)) await attachCompanies(tenantId);
  return { imported: fresh.length, updated };
}

/* One step of the sync: pages of changed contacts until the time budget is used. Returns the sync row afterwards. */
export async function syncCrm(t: Tenant, budget = BUDGET): Promise<Sync | null> {
  const s = await crmSyncOf(t.id);
  if (!s?.property) return s;
  const token = await hubspotToken(t.id);
  if (!token) { await db.update(crmSyncs).set({ status: "fehler", error: "HubSpot ist nicht verbunden", updatedAt: new Date() }).where(eq(crmSyncs.id, s.id)); return crmSyncOf(t.id); }
  /* one step at a time, whether the cron or a click drives it */
  const now = new Date();
  const [mine] = await db.update(crmSyncs).set({ lockedUntil: new Date(now.getTime() + LOCK), status: "läuft" })
    .where(and(eq(crmSyncs.id, s.id), or(isNull(crmSyncs.lockedUntil), lt(crmSyncs.lockedUntil, now)))).returning();
  if (!mine) return s;
  const end = now.getTime() + budget, rule = { property: s.property, value: s.value };
  let cursor = Number(s.cursor) || 0, imported = 0, updated = 0, error = "", after: string | undefined, done = false;
  const since = cursor;
  try {
    while (Date.now() < end) {
      const page = await hubspotContactsChanged(token, rule, since, [...new Set([...PROPS, s.property])], after);
      const r = await fileContacts(t.id, s.property, page.results, token);
      imported += r.imported; updated += r.updated;
      for (const c of page.results) cursor = Math.max(cursor, Date.parse(c.properties.lastmodifieddate || "") || 0);
      after = page.after;
      /* HubSpot's search pages end at 10,000 results; the next step starts again from the newest change read */
      if (!after || Number(after) >= 9900) { done = !after; break; }
    }
  } catch (e) { error = (e as Error).message.slice(0, 300); }
  await db.update(crmSyncs).set({ cursor: cursor ? String(cursor) : "", imported: sql`${crmSyncs.imported} + ${imported}`, updated: sql`${crmSyncs.updated} + ${updated}`,
    status: error ? "fehler" : done ? "bereit" : "läuft", error, lockedUntil: null, lastRunAt: new Date(), updatedAt: new Date() }).where(eq(crmSyncs.id, s.id));
  return crmSyncOf(t.id);
}
