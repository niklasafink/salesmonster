import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/leads/route";
import { POST as PARSE } from "@/app/api/leads/parse/route";
import { call, fixtures } from "./helpers";

const fx = fixtures();
let me: { id: number }, slug: string;

beforeAll(async () => {
  me = await fx.user();
  slug = (await fx.tenant(me)).slug;
  const seed = [
    { co: "Müller Bau GmbH", p: "Hans Müller", role: "Geschäftsführung", email: "hans@mueller-bau.de", web: "www.mueller-bau.de", city: "Köln" },
    { co: "Schmidt Metall GmbH", p: "", role: "", email: "", web: "", city: "" },
  ];
  expect(await call(POST, { as: me, body: { t: slug, rows: seed, source: "Test" } })).toEqual({ status: 200, json: { n: 2 } });
});
afterAll(() => fx.cleanup());

describe("Lead-Import über die Leads-Routen", () => {
  it("ohne Session-Cookie 401", async () => {
    expect((await call(GET, { path: `/api/leads?t=${slug}` })).status).toBe(401);
  });

  it("fremder Mandant antwortet wie ein fehlender", async () => {
    const other = await fx.user();
    expect((await call(GET, { as: other, path: `/api/leads?t=${slug}` })).status).toBe(404);
  });

  it("legt Leads an mit Name, Rolle, Quelle und Status", async () => {
    const { json } = await call(GET, { as: me, path: `/api/leads?t=${slug}` });
    const m = json.rows.find((r: { company: string }) => r.company === "Müller Bau GmbH");
    expect(m).toMatchObject({ first: "Hans", last: "Müller", role: "Geschäftsführung", email: "hans@mueller-bau.de", city: "Köln", source: "Test", status: "neu" });
  });

  it("Import legt Firma an und ordnet weitere Kontakte ihr zu", async () => {
    await call(POST, { as: me, body: { t: slug, rows: [{ co: "Müller Bau", sal: "Frau", p: "Eva Müller", role: "", email: "eva@mueller-bau.de", web: "", city: "", li: "https://linkedin.com/in/eva", hook: "der Neubau" }] } });
    const { json } = await call(GET, { as: me, path: `/api/leads?t=${slug}` });
    const ms = json.rows.filter((r: { company: string }) => r.company.startsWith("Müller Bau"));
    expect(ms).toHaveLength(2);
    expect(ms[0].companyId).toEqual(expect.any(Number));
    expect(ms[1].companyId).toBe(ms[0].companyId);
    expect(ms.find((r: { first: string }) => r.first === "Eva")).toMatchObject({ salutation: "Frau", linkedin: "https://linkedin.com/in/eva", hook: "der Neubau" });
    expect(json.companies.map((c: { id: number }) => c.id)).toContain(ms[0].companyId);
  });

  it("Vorschau erkennt Duplikat per Mail, bekannte Firma ohne Mail und weiteren Kontakt", async () => {
    const text = [
      "Müller Bau GmbH - GF: Hans Müller, HANS@mueller-bau.de",
      "Schmidt Metall GmbH - Inhaber: Karl Schmidt",
      "Schmidt Metall GmbH - Ansprechpartner: Eva Schmidt, eva@schmidt-metall.de",
      "Neu Holz AG - GF: Anna Neu, anna@neuholz.de www.neuholz.de",
    ].join("\n");
    const { status, json } = await call(PARSE, { as: me, body: { t: slug, text } });
    expect(status).toBe(200);
    expect(json.rows.map((r: { co: string; dup: string; extra: string }) => [r.co, r.dup, r.extra])).toEqual([
      ["Müller Bau GmbH", "Schon in der Liste", ""],
      ["Schmidt Metall GmbH", "Firma bekannt", ""],
      ["Schmidt Metall GmbH", "", "Weiterer Kontakt"],
      ["Neu Holz AG", "", ""],
    ]);
  });

  it("Tabulator-Text aus einer Datei: Kopfzeile wird kein Lead", async () => {
    const text = "Firma\tAnsprechpartner\tE-Mail\tWebsite\nWeber Bau GmbH\tAnna Weber\tanna@weber-bau.de\twww.weber-bau.de";
    const { json } = await call(PARSE, { as: me, body: { t: slug, text } });
    expect(json.rows.map((r: { co: string; email: string; web: string }) => [r.co, r.email, r.web])).toEqual([["Weber Bau GmbH", "anna@weber-bau.de", "www.weber-bau.de"]]);
  });

  it("Tabelle mit Semikolon ohne KI: Spalten erkannt, ungültige E-Mail markiert", async () => {
    const text = "Firma;Vorname;Name;E-Mail;Ort\nLang Glas GmbH;Lea;Lang;lea@langglas.de;Ulm\nKurz Stahl AG;Kai;Kurz;kai@kurz;Hof";
    const { json } = await call(PARSE, { as: me, body: { t: slug, text } });
    expect(json.rows.map((r: { co: string; p: string; email: string; city: string; dup: string; extra: string }) => [r.co, r.p, r.email, r.city, r.dup, r.extra])).toEqual([
      ["Lang Glas GmbH", "Lea Lang", "lea@langglas.de", "Ulm", "", ""], ["Kurz Stahl AG", "Kai Kurz", "", "Hof", "", "E-Mail ungültig"]]);
  });
});
