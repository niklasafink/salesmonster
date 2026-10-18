import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET } from "@/app/api/leads/route";
import { call, connectorTokens, fixtures, mcp } from "./helpers";

const fx = fixtures();
let me: { id: number }, t: { id: number; slug: string }, theirs: { slug: string }, c: Awaited<ReturnType<typeof mcp>>;

beforeAll(async () => {
  me = await fx.user(); t = await fx.tenant(me);
  theirs = await fx.tenant(await fx.user());
  c = await mcp((await connectorTokens(me)).access_token);
});
afterAll(async () => { await c?.close(); await fx.cleanup(); });

type Added = { added: { id: number; company: string; companyId: number }[]; skipped: { company: string; why: string }[] };

describe("leads_add", () => {
  it("legt neue an, überspringt Duplikate mit Grund, Quelle Standard Claude", async () => {
    const first = await c.tool<Added>("leads_add", { tenant: t.slug, rows: [
      { company: "Alpha GmbH", person: "Ida Alpha", role: "CEO", email: "ida@alpha.de", website: "alpha.de", city: "Köln" }, { company: "Beta AG" }] });
    expect(first.added.map(a => a.company)).toEqual(["Alpha GmbH", "Beta AG"]);
    expect(first.skipped).toEqual([]);

    const again = await c.tool<Added>("leads_add", { tenant: t.slug, source: "Messe", rows: [
      { company: "Alpha GmbH", person: "Ida Alpha", email: "IDA@alpha.de" }, { company: "Beta AG", person: "Bo Beta" }, { company: "Beta AG", person: "Cy Beta", email: "info@beta.de" }] });
    expect(again.skipped).toEqual([{ company: "Alpha GmbH", why: "Schon in der Liste" }, { company: "Beta AG", why: "Firma bekannt" }]);
    expect(again.added.map(a => a.company)).toEqual(["Beta AG"]);

    const { json } = await call(GET, { as: me, path: `/api/leads?t=${t.slug}` });
    const byId = new Map(json.rows.map((r: { id: number }) => [r.id, r]));
    expect(byId.get(first.added[0].id)).toMatchObject({ company: "Alpha GmbH", first: "Ida", last: "Alpha", role: "CEO", email: "ida@alpha.de", city: "Köln", source: "Claude" });
    expect(byId.get(again.added[0].id)).toMatchObject({ company: "Beta AG", email: "info@beta.de", source: "Messe" });
    expect(json.rows).toHaveLength(3);
  });

  it("Kontakte derselben Firma teilen companyId, Anrede/LinkedIn/Anlass/Fundstelle bleiben", async () => {
    const u = await fx.tenant(me);
    const r = await c.tool<Added>("leads_add", { tenant: u.slug, rows: [
      { company: "Kappa GmbH", salutation: "frau dr.", person: "Kim Kappa", email: "kim@kappa.de", linkedin: "https://linkedin.com/in/kim", hook: "die neue Halle", sourceUrl: "https://kappa.de/team" },
      { company: "Kappa GmbH", person: "Kai Kappa", email: "kai@kappa.de" }, { company: "Lambda AG" }] });
    const [kim, kai, lam] = r.added;
    expect(kim.companyId).toEqual(expect.any(Number));
    expect(kai.companyId).toBe(kim.companyId);
    expect(lam.companyId).not.toBe(kim.companyId);
    const later = await c.tool<Added>("leads_add", { tenant: u.slug, rows: [{ company: "Kappa", person: "Kurt Kappa", email: "kurt@kappa.de" }] });
    expect(later.added[0].companyId).toBe(kim.companyId);
    const list = await c.tool<List>("leads_list", { tenant: u.slug, companyId: kim.companyId });
    expect(list.rows.map(l => l.first).sort()).toEqual(["Kai", "Kim", "Kurt"]);
    expect(list.rows.find(l => l.id === kim.id)).toMatchObject({ companyId: kim.companyId, salutation: "Frau Dr.", linkedin: "https://linkedin.com/in/kim", hook: "die neue Halle", sourceUrl: "https://kappa.de/team" });
  });

  it("mehr als 200 Zeilen werden abgelehnt", async () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({ company: `X${i}` }));
    await expect(c.tool("leads_add", { tenant: t.slug, rows })).rejects.toThrow();
  });

  it("fremder Mandant → Mandant nicht gefunden", async () => {
    await expect(c.tool("leads_add", { tenant: theirs.slug, rows: [{ company: "Z" }] })).rejects.toThrow("Mandant nicht gefunden");
  });
});

type Lead = { id: number; companyId: number; company: string; salutation: string; sourceUrl: string; first: string; last: string; email: string; emailType: string; status: string; note: string; hook: string; linkedin: string; website: string; city: string; role: string; source: string };
type List = { total: number; rows: Lead[] };

describe("leads_list", () => {
  let u: { slug: string };
  beforeAll(async () => {
    u = await fx.tenant(me);
    await c.tool("leads_add", { tenant: u.slug, rows: [{ company: "Gamma GmbH", email: "a@gamma.de", person: "Al Gamma" }, { company: "Delta KG" }, { company: "Epsilon AG", website: "epsilon.de" }] });
  });

  it("liefert Leads mit id, neueste zuerst, und Gesamtzahl", async () => {
    const r = await c.tool<List>("leads_list", { tenant: u.slug });
    expect(r.total).toBe(3);
    expect(r.rows.map(l => l.company)).toEqual(["Epsilon AG", "Delta KG", "Gamma GmbH"]);
    expect(r.rows[2]).toMatchObject({ id: expect.any(Number), first: "Al", last: "Gamma", email: "a@gamma.de", status: "neu", source: "Claude", hook: "", note: "" });
  });

  it("filtert nach query, missing, status und blättert mit limit/offset", async () => {
    expect((await c.tool<List>("leads_list", { tenant: u.slug, query: "gamma" })).rows.map(l => l.company)).toEqual(["Gamma GmbH"]);
    expect((await c.tool<List>("leads_list", { tenant: u.slug, missing: "email" })).rows.map(l => l.company)).toEqual(["Epsilon AG", "Delta KG"]);
    expect((await c.tool<List>("leads_list", { tenant: u.slug, missing: "website", query: "gmbh" })).rows.map(l => l.company)).toEqual(["Gamma GmbH"]);
    expect(await c.tool<List>("leads_list", { tenant: u.slug, limit: 1, offset: 1 })).toMatchObject({ total: 3, rows: [{ company: "Delta KG" }] });
    expect((await c.tool<List>("leads_list", { tenant: u.slug, status: "angeschrieben" })).rows).toEqual([]);
  });

  it("limit über 200 wird abgelehnt, fremder Mandant nicht gefunden", async () => {
    await expect(c.tool("leads_list", { tenant: u.slug, limit: 201 })).rejects.toThrow();
    await expect(c.tool("leads_list", { tenant: theirs.slug })).rejects.toThrow("Mandant nicht gefunden");
  });
});

describe("leads_update", () => {
  it("ändert nur gesetzte Felder, meldet fremde und unbekannte IDs", async () => {
    const u = await fx.tenant(me), v = await fx.tenant(me);
    const { added: [a, b] } = await c.tool<Added>("leads_add", { tenant: u.slug, rows: [{ company: "Zeta GmbH", person: "Zoe Zeta", email: "zoe@zeta.de", city: "Bonn" }, { company: "Eta AG" }] });
    const { added: [elsewhere] } = await c.tool<Added>("leads_add", { tenant: v.slug, rows: [{ company: "Theta GmbH" }] });

    const r = await c.tool<{ updated: number[]; notFound: number[] }>("leads_update", { tenant: u.slug, updates: [
      { id: a.id, hook: "Neue Ausschreibung", note: "", city: "", linkedin: "https://linkedin.com/in/zoe", status: "beantwortet" },
      { id: b.id, first: "Eli", last: "Eta", role: "Inhaber", email: "eli@eta.de", website: "eta.de" },
      { id: elsewhere.id, note: "darf nicht" }, { id: 999999999, note: "x" }] });
    expect(r).toEqual({ updated: [a.id, b.id], notFound: [elsewhere.id, 999999999] });

    const rows = (await c.tool<List>("leads_list", { tenant: u.slug })).rows, byId = new Map(rows.map(l => [l.id, l]));
    expect(byId.get(a.id)).toMatchObject({ hook: "Neue Ausschreibung", note: "", city: "Bonn", linkedin: "https://linkedin.com/in/zoe", status: "beantwortet", email: "zoe@zeta.de", first: "Zoe" });
    expect(byId.get(b.id)).toMatchObject({ first: "Eli", last: "Eta", role: "Inhaber", email: "eli@eta.de", emailType: "person", website: "https://eta.de", status: "neu" });
    expect((await c.tool<List>("leads_list", { tenant: v.slug })).rows[0].note).toBe("");
  });

  it("Anrede wird vereinheitlicht, neuer Firmenname ordnet der Firma zu", async () => {
    const u = await fx.tenant(me);
    const { added: [a, b] } = await c.tool<Added>("leads_add", { tenant: u.slug, rows: [{ company: "My GmbH", person: "Mo My", email: "mo@my.de" }, { company: "Ny AG", person: "Nu Ny", email: "nu@ny.de" }] });
    await c.tool("leads_update", { tenant: u.slug, updates: [{ id: b.id, company: "My GmbH", salutation: "herr prof. dr.", sourceUrl: "https://my.de", research: "Recherche" }] });
    const l = (await c.tool<List>("leads_list", { tenant: u.slug, companyId: a.companyId })).rows.find(x => x.id === b.id);
    expect(l).toMatchObject({ company: "My GmbH", companyId: a.companyId, salutation: "Herr Prof. Dr.", sourceUrl: "https://my.de" });
  });

  it("emailType folgt Adresse und Name, auch wenn nur Vor- oder Nachname kommt; Website mit https://", async () => {
    const u = await fx.tenant(me);
    const { added: [a] } = await c.tool<Added>("leads_add", { tenant: u.slug, rows: [{ company: "Kappa GmbH", email: "anna@kappa.de", website: "httpkappa.de" }] });
    const get = async () => (await c.tool<List>("leads_list", { tenant: u.slug })).rows.find(x => x.id === a.id)!;
    expect(await get()).toMatchObject({ emailType: "info", website: "https://httpkappa.de" });
    await c.tool("leads_update", { tenant: u.slug, updates: [{ id: a.id, last: "Kappa" }] });
    expect((await get()).emailType).toBe("person");
    await c.tool("leads_update", { tenant: u.slug, updates: [{ id: a.id, email: "info@kappa.de", website: "kappa.de" }] });
    expect(await get()).toMatchObject({ emailType: "info", website: "https://kappa.de" });
    await c.tool("leads_update", { tenant: u.slug, updates: [{ id: a.id, email: "anna@kappa.de", website: "http://kappa.de" }] });
    expect(await get()).toMatchObject({ emailType: "person", website: "http://kappa.de" });
  });

  it("fremder Mandant → Mandant nicht gefunden", async () => {
    await expect(c.tool("leads_update", { tenant: theirs.slug, updates: [{ id: 1, note: "x" }] })).rejects.toThrow("Mandant nicht gefunden");
  });
});

describe("Fehler", () => {
  it("Datenbank- und Laufzeitfehler kommen als „Interner Fehler“ an, ohne SQL", async () => {
    await expect(c.tool("leads_list", { tenant: t.slug, companyId: 99999999999 })).rejects.toThrow(/^Interner Fehler$/);
  });
});
