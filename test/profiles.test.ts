import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, leads, templates, tenants } from "@/db";
import { createProfile, listProfiles } from "@/lib/profiles";
import { mailQueue } from "@/lib/queue";
import { GET as LIST, PATCH as ASSIGN } from "@/app/api/leads/route";
import { PATCH as LEAD } from "@/app/api/leads/[id]/route";
import { PUT as TPL } from "@/app/api/templates/[id]/route";
import { GET as PROFILES, POST as NEW_PROFILE } from "@/app/api/profiles/route";
import { call, connectorTokens, fixtures, mcp } from "./helpers";

const fx = fixtures();
type T = typeof tenants.$inferSelect;
let me: { id: number }, t: T, other: T, bekri: number, c: Awaited<ReturnType<typeof mcp>>;
const ids: Record<string, number> = {};

beforeAll(async () => {
  me = await fx.user(); t = await fx.tenant(me); other = await fx.tenant(await fx.user());
  const rows = await db.insert(leads).values([
    { tenantId: t.id, company: "Alpha GmbH", first: "Anna", email: "anna@alpha.de", rating: 90 },
    { tenantId: t.id, company: "Beta WPG", first: "Bert", email: "bert@beta.de", rating: 80 },
    { tenantId: other.id, company: "Fremd GmbH", first: "Fritz", email: "fritz@fremd.de" },
  ]).returning({ id: leads.id, first: leads.first });
  for (const r of rows) ids[r.first] = r.id;
  await db.insert(templates).values({ tenantId: t.id, key: "A", name: "Allgemein", subject: "Hallo", body: "{{anrede}}\n\nText\n\n{{absender}}" });
  c = await mcp((await connectorTokens(me)).access_token);
});
afterAll(async () => { await c?.close(); await fx.cleanup(); });

const tenant = async () => (await db.select().from(tenants).where(eq(tenants.id, t.id)))[0];
const profileOf = async (id: number) => (await db.select({ p: leads.profileId }).from(leads).where(eq(leads.id, id)))[0].p;

describe("Profile", () => {
  it("jeder Mandant hat ein Standardprofil, neue Namen sind eindeutig", async () => {
    const list = await listProfiles(t.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Allgemein", isDefault: true });
    const r = await call(NEW_PROFILE, { as: me, body: { t: t.slug, name: "Bekri", audience: "Kleine WP-Praxen" } });
    expect(r.status).toBe(200);
    bekri = r.json.profile.id;
    await expect(createProfile(t.id, "bekri")).rejects.toThrow(/gibt es schon/);
    const { json } = await call(PROFILES, { as: me, path: `/api/profiles?t=${t.slug}` });
    expect(json.profiles.map((p: { name: string }) => p.name)).toEqual(["Allgemein", "Bekri"]);
    /* only members see a tenant's profiles; others get the same 404 as for a tenant that does not exist */
    expect((await call(PROFILES, { as: me, path: `/api/profiles?t=${other.slug}` })).status).toBe(404);
  });

  it("Zuweisen: Sammel-PATCH nur für eigene Leads, Standardprofil wird null, einzelner Lead per PATCH", async () => {
    const r = await call(ASSIGN, { as: me, method: "PATCH", body: { t: t.slug, ids: [ids.Bert, ids.Fritz], profile: bekri } });
    expect(r.json).toEqual({ n: 1 });
    expect(await profileOf(ids.Bert)).toBe(bekri);
    expect(await profileOf(ids.Fritz)).toBeNull();
    const def = (await listProfiles(t.id)).find(p => p.isDefault)!;
    await call(LEAD, { as: me, method: "PATCH", body: { profileId: def.id }, ctx: { params: Promise.resolve({ id: String(ids.Bert) }) } });
    expect(await profileOf(ids.Bert)).toBeNull();
    await call(LEAD, { as: me, method: "PATCH", body: { profileId: bekri }, ctx: { params: Promise.resolve({ id: String(ids.Bert) }) } });
    expect(await profileOf(ids.Bert)).toBe(bekri);
    /* a profile of another tenant is refused */
    const theirs = await createProfile(other.id, "Fremdprofil");
    expect((await call(ASSIGN, { as: me, method: "PATCH", body: { t: t.slug, ids: [ids.Anna], profile: theirs.id } })).status).toBe(400);
  });

  it("die Liste liefert Profile und profileId je Lead", async () => {
    const { json } = await call(LIST, { as: me, path: `/api/leads?t=${t.slug}` });
    expect(json.profiles.map((p: { name: string }) => p.name)).toEqual(["Allgemein", "Bekri"]);
    const byId = new Map(json.rows.map((r: { id: number; profileId: number | null }) => [r.id, r.profileId]));
    expect(byId.get(ids.Anna)).toBeUndefined();
    expect(byId.get(ids.Bert)).toBe(bekri);
  });

  it("Versand: Leads eines Profils ohne aktive Vorlage warten, mit Vorlage kommen sie in die Schlange", async () => {
    expect((await mailQueue(await tenant())).map(q => q.id)).toEqual([ids.Anna]);
    const [tpl] = await db.insert(templates).values({ tenantId: t.id, key: "K1", name: "Bekri", subject: "Prüfungsbericht", body: "{{anrede}}\n\nText\n\n{{absender}}", active: false }).returning();
    const r = await call(TPL, { as: me, method: "PUT", body: { profileId: bekri, active: true }, ctx: { params: Promise.resolve({ id: String(tpl.id) }) } });
    expect(r.status).toBe(200);
    expect((await db.select().from(templates).where(eq(templates.id, tpl.id)))[0]).toMatchObject({ profileId: bekri, active: true });
    expect((await mailQueue(await tenant())).map(q => q.id)).toEqual([ids.Anna, ids.Bert]);
  });

  it("MCP: leads_add mit Profil, leads_list filtert und nennt das Profil, leads_update wechselt es", async () => {
    const add = await c.tool<{ added: { id: number }[] }>("leads_add", { tenant: t.slug, profile: "Bekri", rows: [{ company: "Gamma WPG", person: "Gina Gamma", email: "gina@gamma.de" }] });
    const gina = add.added[0].id;
    expect(await profileOf(gina)).toBe(bekri);
    const list = await c.tool<{ total: number; rows: { id: number; profile: string }[] }>("leads_list", { tenant: t.slug, profile: "Bekri" });
    expect(list.rows.map(r => r.id).sort()).toEqual([ids.Bert, gina].sort());
    expect(list.rows.every(r => r.profile === "Bekri")).toBe(true);
    const all = await c.tool<{ rows: { id: number; profile: string }[] }>("leads_list", { tenant: t.slug });
    expect(all.rows.find(r => r.id === ids.Anna)?.profile).toBe("Allgemein");
    await c.tool("leads_update", { tenant: t.slug, updates: [{ id: gina, profile: "Allgemein" }] });
    expect(await profileOf(gina)).toBeNull();
    await expect(c.tool("leads_add", { tenant: t.slug, profile: "Gibtsnicht", rows: [{ company: "X" }] })).rejects.toThrow(/Unbekanntes Profil/);
  });
});
