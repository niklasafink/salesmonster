import { getInteg } from "./integrations";

export class HubSpotError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function hs(token: string, path: string, init?: RequestInit) {
  const r = await fetch(`https://api.hubapi.com${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers || {}) } });
  if (!r.ok) throw new HubSpotError(r.status, `HubSpot ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export async function hubspotToken(tenantId: number) {
  return (await getInteg(tenantId, "hubspot"))?.token || null;
}

/* Tenants whose tokens point at the same portal share one list of claimed companies */
export async function hubspotPortal(token: string) {
  const j = await hs(token, "/account-info/v3/details");
  return String(j.portalId);
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
