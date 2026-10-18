import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, leads } from "@/db";
import { setInteg } from "@/lib/integrations";
import { addLeads, checkLeads, type LeadRow } from "@/lib/lead-import";
import { fakeOpenRouter, fixtures } from "./helpers";

const fx = fixtures();
let me: { id: number }, tid: number, bare: number;
const row = (r: Partial<LeadRow>): LeadRow => ({ co: "", p: "", role: "", email: "", web: "", city: "", ...r });
/* Jev's answer for every same-person question: yes when `same` says so */
const judge = (same: (q: string) => boolean) => fakeOpenRouter({ jev: (_s, qs) => Object.fromEntries(Object.entries(qs).map(([k, q]) =>
  [k, k.startsWith("d") ? { type: "noul", noul: same(String((q as { instructions: string }).instructions)) ? 0.95 : 0.1 } : { type: "choice", choice: "unklar", probabilities: { unklar: 1 } }])) });

beforeAll(async () => {
  me = await fx.user();
  tid = (await fx.tenant(me)).id;
  bare = (await fx.tenant(me)).id;
  await setInteg(tid, "openrouter", me.id, { key: "sk-or-test" });
  for (const t of [tid, bare]) await addLeads(t, [
    row({ co: "Müller Bau GmbH", p: "Hans Müller", role: "Geschäftsführung", email: "hans@mueller-bau.de", web: "www.mueller-bau.de", city: "Köln" }),
    row({ co: "Krause Elektro KG", p: "S. Krause", email: "" }),
  ], "Test");
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(() => fx.cleanup());

describe("Doppelte Kontakte beim Import", () => {
  it("dieselbe Liste noch einmal legt nichts an", async () => {
    const out = await checkLeads(tid, [row({ co: "Müller Bau GmbH", p: "Hans Müller", email: "hans@mueller-bau.de" })]);
    expect(out[0]).toMatchObject({ dup: "Schon in der Liste" });
  });

  it("Titel, Umlaut-Schreibung und Rechtsform machen keinen neuen Kontakt, die Zeile ergänzt", async () => {
    const out = await checkLeads(tid, [row({ co: "Mueller Bau GmbH & Co. KG", p: "Dr. Hans Mueller", phone: "0221 1" })]);
    expect(out[0]).toMatchObject({ dup: "", extra: "Wird ergänzt", id: expect.any(Number) });
  });

  it("gleiche Domain, anderer Firmenname: derselbe Kontakt", async () => {
    const out = await checkLeads(tid, [row({ co: "MB Bauunternehmung", p: "Hans Müller", web: "https://mueller-bau.de/kontakt", phone: "0221 2" })]);
    expect(out[0]).toMatchObject({ extra: "Wird ergänzt" });
  });

  it("doppelt in der Datei: die erste Zeile übernimmt, was die zweite weiß", async () => {
    const out = await checkLeads(tid, [row({ co: "Neu Holz GmbH", p: "Ida Neu" }), row({ co: "Neu Holz", p: "Ida Neu", phone: "030 9", email: "ida@neuholz.de" })]);
    expect(out.map(r => r.dup)).toEqual(["", "Doppelt in der Datei"]);
    expect(out[0]).toMatchObject({ phone: "030 9", email: "ida@neuholz.de" });
  });

  it("unklarer Fall geht an Jev: Initial wird zum vollen Vornamen", async () => {
    const seen = judge(q => q.includes("Sven Krause"));
    const out = await checkLeads(tid, [row({ co: "Krause Elektro", p: "Sven Krause", email: "sven@krause-elektro.de" })]);
    expect(seen.some(s => s.url.endsWith("/alpha/decisions"))).toBe(true);
    expect(out[0]).toMatchObject({ dup: "", extra: "Wird ergänzt", id: expect.any(Number) });
    await addLeads(tid, [row({ co: "Krause Elektro", p: "Sven Krause", email: "sven@krause-elektro.de" })], "Test");
    const ks = await db.select().from(leads).where(and(eq(leads.tenantId, tid), eq(leads.last, "Krause")));
    expect(ks.map(l => [l.first, l.email])).toEqual([["Sven", "sven@krause-elektro.de"]]);
  });

  it("Jev sagt nein: Kollegin mit ähnlichem Namen wird angelegt", async () => {
    judge(() => false);
    const out = await checkLeads(tid, [row({ co: "Müller Bau GmbH", p: "Hanna Müller", email: "hanna@mueller-bau.de" })]);
    expect(out[0]).toMatchObject({ dup: "", extra: "Weiterer Kontakt" });
    expect(out[0].id).toBeUndefined();
  });

  it("anderer Vorname bei derselben Firma fragt Jev gar nicht", async () => {
    const seen = judge(() => true);
    const out = await checkLeads(tid, [row({ co: "Müller Bau GmbH", p: "Eva Schulz", email: "eva@mueller-bau.de" })]);
    expect(seen.filter(s => Object.keys(s.body.questions as object).some(k => k.startsWith("d")))).toHaveLength(0);
    expect(out[0]).toMatchObject({ dup: "", extra: "Weiterer Kontakt" });
  });

  it("ohne KI-Schlüssel bleibt ein unklarer Fall drin und wird markiert", async () => {
    const out = await checkLeads(bare, [row({ co: "Krause Elektro", p: "Sven Krause" })]);
    expect(out[0]).toMatchObject({ dup: "", extra: "Möglicherweise doppelt" });
  });
});
