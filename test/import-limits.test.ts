import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as PARSE } from "@/app/api/leads/parse/route";
import { addLeads, checkLeads } from "@/lib/lead-import";
import { setInteg } from "@/lib/integrations";
import { call, fixtures } from "./helpers";

/* AI parse replaced by a stand-in that reads one contact per data row and records how it was called */
const ai = vi.hoisted(() => ({ calls: [] as string[], open: 0, max: 0 }));
vi.mock("@/lib/ai", async orig => ({ ...await orig<typeof import("@/lib/ai")>(), aiFor: async () => ({ provider: "anthropic", key: "k" }) }));
vi.mock("@/lib/claude", async orig => ({
  ...await orig<typeof import("@/lib/claude")>(),
  parseImport: async (_k: unknown, raw: string) => {
    ai.calls.push(raw); ai.max = Math.max(ai.max, ++ai.open);
    await new Promise(r => setTimeout(r, 20)); ai.open--;
    return raw.split("\n").slice(1).map(l => ({ co: l.split("\t")[0], sal: "", p: "", role: "", email: "", web: "", city: "", li: "", hook: "" }));
  },
}));

const fx = fixtures();
let me: { id: number }, slug: string, tid: number;
beforeAll(async () => { me = await fx.user(); const t = await fx.tenant(me); slug = t.slug; tid = t.id; });
afterAll(() => fx.cleanup());
afterEach(() => { vi.unstubAllGlobals(); ai.calls = []; ai.max = 0; });

const table = (n: number, extra = "") => ["Firma\tOrt", ...Array.from({ length: n }, (_, i) => `Firma ${i} GmbH\tOrt ${i}${extra}`)].join("\n");

describe("Import großer Tabellen", () => {
  it("teilt in Stücke zu 120 Zeilen mit Kopfzeile, höchstens 3 gleichzeitig, alle Zeilen kommen an", async () => {
    const { status, json } = await call(PARSE, { as: me, body: { t: slug, text: table(500) } });
    expect(status).toBe(200);
    expect(json.rows.map((r: { co: string }) => r.co)).toEqual(Array.from({ length: 500 }, (_, i) => `Firma ${i} GmbH`));
    expect(ai.calls).toHaveLength(5);
    for (const c of ai.calls) expect(c.startsWith("Firma\tOrt\n")).toBe(true);
    expect(ai.max).toBe(3);
  });

  it("zu viel Text wird abgelehnt statt abgeschnitten", async () => {
    const free = await call(PARSE, { as: me, body: { t: slug, text: `Muster GmbH ${"x".repeat(40001)}` } });
    expect(free.status).toBe(400);
    expect(free.json.error).toMatch(/Zeichen/);
    expect((await call(PARSE, { as: me, body: { t: slug, text: table(1001) } })).status).toBe(400);
    expect((await call(PARSE, { as: me, body: { t: slug, text: table(120, "\t" + "y".repeat(400)) } })).status).toBe(400);
    expect(ai.calls).toHaveLength(0);
  });
});

describe("HubSpot-Abgleich", () => {
  const real = globalThis.fetch;
  function hubspot(answer: (company: string, n: number) => number) {
    const seen = new Map<string, number>(); let open = 0, max = 0;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).startsWith("https://api.hubapi.com")) return real(url, init);
      const co = JSON.parse(String(init?.body)).filterGroups[0].filters[0].value as string, n = (seen.get(co) || 0) + 1;
      seen.set(co, n); max = Math.max(max, ++open);
      await new Promise(r => setTimeout(r, 10)); open--;
      const status = answer(co, n);
      return new Response(status === 200 ? JSON.stringify({ total: 0, results: [] }) : "nope", { status });
    });
    return { seen, max: () => max };
  }
  const row = (co: string) => ({ co, p: "", role: "", email: "", web: "", city: "" });

  it("höchstens 4 gleichzeitig, 429 wird wiederholt, dauerhafte Fehler markieren die Zeile", async () => {
    await setInteg(tid, "hubspot", null, { token: "tok" });
    const hs = hubspot((co, n) => co === "Down GmbH" ? 500 : co === "Rate GmbH" && n === 1 ? 429 : co === "Busy GmbH" ? 429 : 200);
    const rows = [...Array.from({ length: 10 }, (_, i) => row(`Ok ${i} GmbH`)), row("Rate GmbH"), row("Down GmbH"), row("Busy GmbH")];
    const out = await checkLeads(tid, rows);
    expect(hs.max()).toBeLessThanOrEqual(4);
    expect(hs.seen.get("Rate GmbH")).toBe(2);
    expect(hs.seen.get("Down GmbH")).toBe(1);
    expect(out.map(r => [r.co, r.dup]).filter(([, d]) => d)).toEqual([["Down GmbH", "HubSpot nicht erreichbar"], ["Busy GmbH", "HubSpot nicht erreichbar"]]);

    const added = await addLeads(tid, [row("Neu GmbH"), row("Down GmbH")], "Test");
    expect(added.added.map(a => a.company)).toEqual(["Neu GmbH"]);
    expect(added.skipped).toEqual([{ company: "Down GmbH", why: "HubSpot nicht erreichbar" }]);
  });
});
