import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, leads, messages, tenants } from "@/db";
import { GET } from "@/app/api/leads/route";
import { GET as CRM_GET, PUT as CRM_PUT } from "@/app/api/crm/route";
import { fileContacts } from "@/lib/crm-sync";
import { inKind, kindOf, kindOfAll } from "@/lib/lead-kind";
import { mailQueue } from "@/lib/queue";
import type { HsContact } from "@/lib/hubspot";
import { call, fixtures } from "./helpers";

const fx = fixtures();
let me: { id: number }, t: typeof tenants.$inferSelect;

const hs = (id: string, props: Record<string, string>): HsContact => ({ id, properties: { createdate: "2026-10-01T10:00:00Z", lastmodifieddate: "2026-10-02T10:00:00Z", ...props } });
const mine = () => db.select().from(leads).where(eq(leads.tenantId, t.id));

beforeAll(async () => {
  me = await fx.user();
  t = await fx.tenant(me);
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(() => fx.cleanup());

describe("Lead oder CRM", () => {
  it("Lead, CRM und beides", () => {
    expect(kindOf({ prospect: true, crmAt: null })).toBe("lead");
    expect(kindOf({ prospect: false, crmAt: "2026-10-01" })).toBe("crm");
    expect(kindOf({ prospect: true, crmAt: "2026-10-01" })).toBe("beides");
  });
  it("der Filter Leads zeigt auch die, die beides sind, CRM ebenso", () => {
    const both = { prospect: true, crmAt: "2026-10-01" };
    expect(inKind(both, "lead") && inKind(both, "crm") && inKind(both, "alle")).toBe(true);
    expect(inKind({ prospect: false, crmAt: "x" }, "lead")).toBe(false);
    expect(inKind({ prospect: true, crmAt: null }, "crm")).toBe(false);
  });
  it("eine Firma ist, was ihre Personen sind", () => {
    expect(kindOfAll([{ prospect: true, crmAt: null }, { prospect: false, crmAt: "x" }])).toBe("beides");
    expect(kindOfAll([{ prospect: false, crmAt: "x" }])).toBe("crm");
  });
});

describe("Registrierte aus HubSpot übernehmen", () => {
  it("legt neue Registrierte als CRM-Kontakt an, nie zum Anschreiben", async () => {
    const r = await fileContacts(t.id, "signup_datum", [hs("9001", { email: "anna@kraft-bau.de", firstname: "Anna", lastname: "Kraft", company: "Kraft Bau GmbH", signup_datum: "2026-09-30", lifecyclestage: "lead" })], null);
    expect(r).toEqual({ imported: 1, updated: 0 });
    const [l] = (await mine()).filter(x => x.hsContactId === "9001");
    expect(l).toMatchObject({ email: "anna@kraft-bau.de", first: "Anna", company: "Kraft Bau GmbH", source: "HubSpot", status: "kontakt", prospect: false, stage: "lead" });
    expect(l.crmAt?.toISOString().slice(0, 10)).toBe("2026-09-30");
    expect(l.companyId).not.toBeNull();
  });

  it("zweimal abgleichen legt nichts doppelt an", async () => {
    const r = await fileContacts(t.id, "signup_datum", [hs("9001", { email: "anna@kraft-bau.de", firstname: "Anna", lastname: "Kraft", company: "Kraft Bau GmbH", lifecyclestage: "customer" })], null);
    expect(r).toEqual({ imported: 0, updated: 1 });
    const ls = (await mine()).filter(x => x.email === "anna@kraft-bau.de");
    expect(ls).toHaveLength(1);
    expect(ls[0].stage).toBe("customer");
  });

  it("ein Lead, der sich registriert, ist beides, wird nicht mehr kalt angeschrieben und sein Entwurf entfällt", async () => {
    const [l] = await db.insert(leads).values({ tenantId: t.id, company: "Ost Logistik", email: "max@ost-logistik.de", first: "Max", status: "freigabe", source: "Claude-Recherche" }).returning();
    await db.insert(messages).values({ tenantId: t.id, leadId: l.id, leadIds: [l.id], batchDate: "2026-10-25", variant: "A", subject: "Hallo", body: "Text", status: "entwurf" });
    await fileContacts(t.id, "signup_datum", [hs("9002", { email: "MAX@ost-logistik.de", firstname: "Max", lastname: "Ost", signup_datum: "2026-10-20" })], null);
    const [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(after).toMatchObject({ prospect: true, status: "kontakt", hsContactId: "9002", last: "Ost", source: "Claude-Recherche" });
    expect(after.crmAt).not.toBeNull();
    expect(await db.select().from(messages).where(eq(messages.leadId, l.id))).toHaveLength(0);
  });

  it("Kollegen derselben HubSpot-Firma landen bei einer Firma, auch bei einer schon vorhandenen mit gleicher Domain", async () => {
    const [old] = await db.insert(leads).values({ tenantId: t.id, company: "Nord Stahl", website: "https://nord-stahl.de", email: "info@nord-stahl.de", status: "neu" }).returning();
    const { attachCompanies } = await import("@/lib/companies");
    await attachCompanies(t.id);
    const [o] = await db.select().from(leads).where(eq(leads.id, old.id));
    await db.execute(`update companies set domain = 'nord-stahl.de' where id = ${o.companyId}`);
    /* only HubSpot is answered here; the database driver talks HTTP too */
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => String(u).startsWith("https://api.hubapi.com")
      ? new Response(JSON.stringify({ results: [{ id: "77", properties: { name: "Nord Stahl GmbH", domain: "nord-stahl.de" } }] })) : real(u, init)));
    await fileContacts(t.id, "signup_datum", [
      hs("9003", { email: "eva@nord-stahl.de", firstname: "Eva", associatedcompanyid: "77" }),
      hs("9004", { email: "tom@nord-stahl.de", firstname: "Tom", associatedcompanyid: "77" }),
    ], "token");
    const ls = (await mine()).filter(x => x.email.endsWith("@nord-stahl.de"));
    expect(new Set(ls.map(x => x.companyId))).toEqual(new Set([o.companyId]));
    expect(ls.filter(x => x.crmAt)).toHaveLength(2);
  });

  it("Registrierte kommen nie in die Versand-Warteschlange, auch nicht mit Status neu von Hand", async () => {
    const [l] = (await mine()).filter(x => x.hsContactId === "9001");
    await db.update(leads).set({ status: "neu" }).where(eq(leads.id, l.id));
    expect((await mailQueue(t)).map(q => q.id)).not.toContain(l.id);
  });

  it("die Liste trägt Art und Registrierung, aber keinen Recherchetext", async () => {
    const { json } = await call(GET, { as: me, path: `/api/leads?t=${t.slug}` });
    /* only in the CRM: in the compact part of the answer */
    expect(json.rows.some((r: { email: string }) => r.email === "anna@kraft-bau.de")).toBe(false);
    const a = json.crm.find((r: { email: string }) => r.email === "anna@kraft-bau.de");
    expect(a).toMatchObject({ hsContactId: "9001", source: "HubSpot" });
    expect(json.rows.find((r: { email: string }) => r.email === "max@ost-logistik.de")).toMatchObject({ prospect: true, hsContactId: "9002" });
    expect(a.crmAt).toBeTruthy();
    expect("research" in a).toBe(false);
  });

  it("die Regel wird je Mandant gespeichert; ohne HubSpot zeigt der Status das", async () => {
    const { json } = await call(CRM_PUT, { as: me, method: "PUT", body: { t: t.slug, property: "signup_datum", value: "" } });
    expect(json).toMatchObject({ hubspot: false, property: "signup_datum", status: "bereit" });
    expect((await call(CRM_GET, { as: me, path: `/api/crm?t=${t.slug}` })).json.contacts).toBeGreaterThanOrEqual(4);
    const other = await fx.user();
    expect((await call(CRM_GET, { as: other, path: `/api/crm?t=${t.slug}` })).status).toBe(404);
  });
});
