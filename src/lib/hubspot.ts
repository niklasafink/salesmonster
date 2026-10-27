import { getInteg } from "./integrations";

export class HubSpotError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function hs(token: string, path: string, init?: RequestInit) {
  const r = await fetch(`https://api.hubapi.com${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers || {}) } });
  if (!r.ok) throw new HubSpotError(r.status, `HubSpot ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/* Lookups that hardly change (account, owners, deal stages, contact ids) kept per token for a while, so the contact dialog
   does not ask HubSpot for them every time; a failed lookup is not kept */
const memo = new Map<string, { until: number; v: Promise<unknown> }>();
function cached<T>(key: string, fn: () => Promise<T>, ms = 10 * 60_000): Promise<T> {
  const hit = memo.get(key);
  if (hit && hit.until > Date.now()) return hit.v as Promise<T>;
  const v = fn();
  memo.set(key, { until: Date.now() + ms, v });
  v.catch(() => memo.delete(key));
  return v;
}

export async function hubspotToken(tenantId: number) {
  return (await getInteg(tenantId, "hubspot"))?.token || null;
}

/* Tenants whose tokens point at the same portal share one list of claimed companies */
export async function hubspotPortal(token: string) {
  const j = await hs(token, "/account-info/v3/details");
  return String(j.portalId);
}

/* for links to records: the portal and the app domain its data lives on (app.hubspot.com, app-eu1.hubspot.com) */
export function hubspotAccount(token: string) {
  return cached(`acc:${token}`, async () => {
    const j = await hs(token, "/account-info/v3/details");
    return { portal: String(j.portalId), ui: String(j.uiDomain || "app.hubspot.com") };
  });
}

/* deal stage id -> label over all deal pipelines */
export function hubspotDealStages(token: string): Promise<Map<string, string>> {
  return cached(`stages:${token}`, async () => {
    const j = await hs(token, "/crm/v3/pipelines/deals");
    return new Map<string, string>((j.results || []).flatMap((p: { stages?: { id: string; label: string }[] }) => (p.stages || []).map(s => [s.id, s.label])));
  }).catch(() => new Map());
}

export async function hubspotVerify(token: string) {
  const j = await hs(token, "/account-info/v3/details");
  return j.portalId ? `Portal ${j.portalId}` : "Portal verbunden";
}

export const domainOf = (s: string) => s.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();

export type Known = { why: string; companyId?: string };

/* Is this company or address already in HubSpot? Returns a reason (and the company, if found) or null. */
export async function hubspotKnown(token: string, company: string, website: string, email: string): Promise<Known | null> {
  const filters = [[{ propertyName: "name", operator: "EQ", value: company }]];
  if (website) filters.push([{ propertyName: "domain", operator: "EQ", value: domainOf(website) }]);
  const c = await hs(token, "/crm/v3/objects/companies/search", { method: "POST", body: JSON.stringify({ filterGroups: filters.map(f => ({ filters: f })), limit: 1 }) });
  if (c.total > 0) return { why: "In HubSpot", companyId: String(c.results[0].id) };
  if (email) {
    const p = await hs(token, "/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }], limit: 1 }) });
    if (p.total > 0) return { why: "Kontakt in HubSpot" };
  }
  return null;
}

export async function hubspotCreateContact(token: string, l: { email: string; first: string; last: string; company: string; role: string; website: string }) {
  await hs(token, "/crm/v3/objects/contacts", { method: "POST", body: JSON.stringify({ properties: {
    email: l.email, firstname: l.first, lastname: l.last, company: l.company, jobtitle: l.role, website: l.website } }) });
}

/* Puts the company (and the person, if known) into HubSpot right away, so it counts as taken
   for everyone working from this portal even before the mail goes out. Returns the company id. */
export async function hubspotReserve(token: string, l: { email: string; first: string; last: string; company: string; role: string; website: string; city: string }) {
  const domain = l.website ? domainOf(l.website) : "";
  const co = await hs(token, "/crm/v3/objects/companies", { method: "POST", body: JSON.stringify({ properties: { name: l.company, domain, city: l.city } }) });
  if (l.email || l.last) {
    await hubspotAddContact(token, String(co.id), l)
      .catch(async e => { await hs(token, `/crm/v3/objects/companies/${co.id}`, { method: "DELETE" }).catch(() => {}); throw e; });
  }
  return String(co.id);
}

/* Another person at a company that is already in HubSpot: stored there, never written to */
export async function hubspotAddContact(token: string, companyId: string, l: { email: string; first: string; last: string; company: string; role: string; website: string }) {
  await hs(token, "/crm/v3/objects/contacts", { method: "POST", body: JSON.stringify({
    properties: { email: l.email, firstname: l.first, lastname: l.last, company: l.company, jobtitle: l.role, website: l.website },
    associations: [{ to: { id: companyId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 1 }] }] }) });
}

export type HsCompany = { id: string; co: string; domain: string; street: string; zip: string; city: string; contact: string; email: string; salut: string };

export async function hubspotCompanies(token: string, q: string): Promise<HsCompany[]> {
  const j = await hs(token, "/crm/v3/objects/companies/search", { method: "POST", body: JSON.stringify({
    query: q, limit: 8, properties: ["name", "domain", "address", "zip", "city"] }) });
  return Promise.all((j.results || []).map(async (r: { id: string; properties: Record<string, string> }) => {
    const p = r.properties;
    let contact = "", email = "";
    try {
      const a = await hs(token, `/crm/v4/objects/companies/${r.id}/associations/contacts?limit=1`);
      const cid = a.results?.[0]?.toObjectId;
      if (cid) {
        const c = await hs(token, `/crm/v3/objects/contacts/${cid}?properties=firstname,lastname,email`);
        contact = [c.properties.firstname, c.properties.lastname].filter(Boolean).join(" ");
        email = c.properties.email || "";
      }
    } catch { /* contact is optional */ }
    return { id: r.id, co: p.name || "", domain: p.domain || "", street: p.address || "", zip: p.zip || "", city: p.city || "", contact, email, salut: "" };
  }));
}

export type HsContact = { id: string; properties: Record<string, string | null> };

/* property = value, or any value when value is empty */
const filterOf = (m: { property: string; value: string }) =>
  m.value ? { propertyName: m.property, operator: "EQ", value: m.value } : { propertyName: m.property, operator: "HAS_PROPERTY" };

/* Contacts matching a property, created since a date, oldest first */
export async function hubspotContactsWhere(token: string, m: { property: string; value: string }, since: string, properties: string[], max = 500): Promise<HsContact[]> {
  const out: HsContact[] = [];
  let after: string | undefined;
  while (out.length < max) {
    const j = await hs(token, "/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify({
      filterGroups: [{ filters: [filterOf(m), { propertyName: "createdate", operator: "GTE", value: String(Date.parse(since)) }] }],
      sorts: [{ propertyName: "createdate", direction: "ASCENDING" }], properties, limit: 100, after }) });
    out.push(...(j.results || []));
    after = j.paging?.next?.after;
    if (!after) break;
  }
  return out;
}

export async function hubspotContactsRead(token: string, ids: string[], properties: string[]): Promise<HsContact[]> {
  const out: HsContact[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const j = await hs(token, "/crm/v3/objects/contacts/batch/read", { method: "POST", body: JSON.stringify({ properties, inputs: ids.slice(i, i + 100).map(id => ({ id })) }) });
    out.push(...(j.results || []));
  }
  return out;
}

/* One page of contacts that match the rule and changed since `since` (ms), oldest change first */
export async function hubspotContactsChanged(token: string, m: { property: string; value: string }, since: number, properties: string[], after?: string) {
  const j = await hs(token, "/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify({
    filterGroups: [{ filters: [filterOf(m), { propertyName: "lastmodifieddate", operator: "GTE", value: String(since) }] }],
    sorts: [{ propertyName: "lastmodifieddate", direction: "ASCENDING" }], properties, limit: 100, after }) });
  return { results: (j.results || []) as HsContact[], total: Number(j.total) || 0, after: j.paging?.next?.after as string | undefined };
}

export type HsActivity = { id: string; properties: Record<string, string | null>; associations?: { contacts?: { results?: { id: string }[] } } };

/* Every activity of one kind (calls, meetings, notes, emails) with the contacts it belongs to, oldest first, up to `max` */
export async function hubspotActivities(token: string, kind: "calls" | "meetings" | "notes" | "emails", properties: string[], max = 5000): Promise<HsActivity[]> {
  const out: HsActivity[] = [];
  let after: string | undefined;
  while (out.length < max) {
    const q = new URLSearchParams({ limit: "100", properties: properties.join(","), associations: "contacts", ...(after ? { after } : {}) });
    const j = await hs(token, `/crm/v3/objects/${kind}?${q}`);
    out.push(...(j.results || []));
    after = j.paging?.next?.after;
    if (!after) break;
  }
  return out;
}

/* Ids of the records of one type associated with a contact or company, up to 500 */
export async function hubspotAssociated(token: string, from: "contacts" | "companies", id: string, to: string): Promise<string[]> {
  const j = await hs(token, `/crm/v4/objects/${from}/${id}/associations/${to}?limit=500`);
  return (j.results || []).map((r: { toObjectId: string | number }) => String(r.toObjectId));
}

/* Records of any object type by id, 100 per call */
export async function hubspotRead(token: string, type: string, ids: string[], properties: string[]): Promise<HsContact[]> {
  const out: HsContact[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const j = await hs(token, `/crm/v3/objects/${type}/batch/read`, { method: "POST", body: JSON.stringify({ properties, inputs: ids.slice(i, i + 100).map(id => ({ id })) }) });
    out.push(...(j.results || []));
  }
  return out;
}

/* a found id is kept, a miss is not, so a contact created in HubSpot meanwhile shows up */
export async function hubspotContactByEmail(token: string, email: string): Promise<string | null> {
  const key = `mail:${token}:${email.toLowerCase()}`, hit = memo.get(key);
  if (hit && hit.until > Date.now()) return hit.v as Promise<string>;
  const j = await hs(token, "/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }], limit: 1 }) });
  const id = j.results?.[0]?.id ? String(j.results[0].id) : null;
  if (id) memo.set(key, { until: Date.now() + 10 * 60_000, v: Promise.resolve(id) });
  return id;
}

/* owner id -> name; empty when the token may not read owners */
export function hubspotOwners(token: string): Promise<Map<string, string>> {
  return cached(`owners:${token}`, async () => {
    const j = await hs(token, "/crm/v3/owners?limit=500");
    return new Map<string, string>((j.results || []).map((o: { id: string; firstName?: string; lastName?: string; email?: string }) => [String(o.id), [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email || ""]));
  }).catch(() => new Map());
}

export async function hubspotCompaniesRead(token: string, ids: string[], properties: string[]): Promise<HsContact[]> {
  const out: HsContact[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const j = await hs(token, "/crm/v3/objects/companies/batch/read", { method: "POST", body: JSON.stringify({ properties, inputs: ids.slice(i, i + 100).map(id => ({ id })) }) });
    out.push(...(j.results || []));
  }
  return out;
}
