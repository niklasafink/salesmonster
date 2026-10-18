import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET } from "@/app/api/leads/route";
import { addLeads } from "@/lib/lead-import";
import { call, fixtures } from "./helpers";

const fx = fixtures();
let me: { id: number }, t: { id: number; slug: string };

beforeAll(async () => { me = await fx.user(); t = await fx.tenant(me); });
afterAll(() => fx.cleanup());

const row = (co: string, p = "", email = "", web = "") => ({ co, p, role: "", email, web, city: "" });

describe("addLeads (Übernahme ohne Vorschau, für MCP)", () => {
  it("legt neue an, überspringt Duplikate mit Grund und liefert IDs", async () => {
    const first = await addLeads(t.id, [row("Alpha GmbH", "Ida Alpha", "ida@alpha.de", "alpha.de"), row("Beta AG")], "Claude");
    expect(first.added.map(a => a.company)).toEqual(["Alpha GmbH", "Beta AG"]);
    expect(first.skipped).toEqual([]);

    const again = await addLeads(t.id, [row("Alpha GmbH", "Ida Alpha", "IDA@alpha.de"), row("Beta AG", "Bo Beta"), row("Beta AG", "Cy Beta", "info@beta.de")], "Claude");
    expect(again.skipped).toEqual([{ company: "Alpha GmbH", why: "Schon in der Liste" }, { company: "Beta AG", why: "Firma bekannt" }]);
    expect(again.added.map(a => a.company)).toEqual(["Beta AG"]);

    const { json } = await call(GET, { as: me, path: `/api/leads?t=${t.slug}` });
    const byId = new Map(json.rows.map((r: { id: number }) => [r.id, r]));
    expect(byId.get(first.added[0].id)).toMatchObject({ company: "Alpha GmbH", first: "Ida", last: "Alpha", source: "Claude" });
    expect(byId.get(again.added[0].id)).toMatchObject({ company: "Beta AG", email: "info@beta.de", source: "Claude" });
    expect(json.rows).toHaveLength(3);
  });
});
