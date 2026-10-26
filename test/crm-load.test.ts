/* Load: a tenant with 12,000 contacts (10,000 registered from HubSpot, 2,000 leads). The list and the grouping into companies
   must stay quick, so the portal still works when a website brings in tens of thousands of registrations. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET } from "@/app/api/leads/route";
import { db, leads } from "@/db";
import { attachCompanies } from "@/lib/companies";
import { rerate } from "@/lib/ratings";
import { fileContacts } from "@/lib/crm-sync";
import type { HsContact } from "@/lib/hubspot";
import { call, fixtures } from "./helpers";

const fx = fixtures();
let me: { id: number }, t: { id: number; slug: string };
const CRM = 10_000, LEADS = 2_000;

beforeAll(async () => {
  me = await fx.user();
  t = await fx.tenant(me);
  for (let i = 0; i < LEADS; i += 1000)
    await db.insert(leads).values(Array.from({ length: Math.min(1000, LEADS - i) }, (_, k) => ({ tenantId: t.id, company: `Recherche Firma ${(i + k) % 700}`, email: `lead${i + k}@firma${(i + k) % 700}.de`,
      first: "Lea", last: `Nr ${i + k}`, hook: "Neubau in Köln", research: "x".repeat(1500), status: "neu" })));
}, 120_000);
afterAll(() => fx.cleanup(), 120_000);

describe("Last mit 12.000 Kontakten", () => {
  it("übernimmt 10.000 Registrierte seitenweise wie aus HubSpot", async () => {
    const t0 = Date.now();
    for (let p = 0; p < CRM / 100; p++) {
      const page: HsContact[] = Array.from({ length: 100 }, (_, k) => { const i = p * 100 + k;
        return { id: String(500000 + i), properties: { email: `user${i}@kunde${i % 3000}.de`, firstname: "Nutzer", lastname: String(i), company: `Kunde ${i % 3000}`, createdate: "2026-10-01T00:00:00Z", lastmodifieddate: "2026-10-01T00:00:00Z" } }; });
      await fileContacts(t.id, "signup_datum", page, null);
    }
    const ms = Date.now() - t0;
    console.log(`Abgleich 10.000 Kontakte: ${ms} ms`);
    expect(ms).toBeLessThan(240_000);
  }, 300_000);

  it("ordnet 2.000 lose Leads in einem Rutsch Firmen zu", async () => {
    const t0 = Date.now();
    await attachCompanies(t.id);
    const ms = Date.now() - t0;
    console.log(`Firmen zuordnen: ${ms} ms`);
    expect(ms).toBeLessThan(20_000);
  }, 60_000);

  it("liefert die Liste schnell und schlank", async () => {
    await call(GET, { as: me, path: `/api/leads?t=${t.slug}` });
    /* ratings that did not change are not written again */
    expect(await rerate(t.id)).toBe(0);
    const t0 = Date.now();
    const { status, json } = await call(GET, { as: me, path: `/api/leads?t=${t.slug}` });
    const ms = Date.now() - t0, kb = Math.round(JSON.stringify(json).length / 1024);
    console.log(`Liste: ${json.rows.length + json.crm.length} Zeilen, ${ms} ms, ${kb} KB (ungepackt)`);
    expect(status).toBe(200);
    expect(json.rows.length + json.crm.length).toBe(CRM + LEADS);
    expect(new Set(json.crm.map((r: { companyId: number }) => r.companyId)).size).toBe(3000);
    /* measured from a laptop against Neon in Frankfurt, with the rating inline (in a request it runs after the answer) */
    expect(ms).toBeLessThan(6_000);
    expect(kb).toBeLessThan(6_000);
  }, 120_000);
});
