import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, tenants } from "@/db";
import { eq } from "drizzle-orm";
import { GET, POST } from "@/app/api/leads/route";
import { PATCH } from "@/app/api/leads/[id]/route";
import { setInteg } from "@/lib/integrations";
import { call, fakeOpenRouter, fitAnswer, fixtures } from "./helpers";

const fx = fixtures();
let me: { id: number }, slug: string;
type Row = { id: number; company: string; email: string; rating: number | null; vote: number; ratingInfo: { grade: string; reasons: { text: string }[] } | null };
const list = async () => (await call(GET, { as: me, path: `/api/leads?t=${slug}` })).json.rows as Row[];
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

beforeAll(async () => {
  me = await fx.user();
  const t = await fx.tenant(me); slug = t.slug;
  await db.update(tenants).set({ settings: { prompt: "Wir verkaufen Ausschreibungsrecherche an Tiefbaufirmen.", leadsPerDay: 10, cooldownDays: 30 } }).where(eq(tenants.id, t.id));
  await setInteg(t.id, "openrouter", me.id, { key: "sk-or-test" });
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(() => fx.cleanup());

describe("Bewertete Leads", () => {
  it("Import: Jev schätzt die Passung, die Liste kommt nach Bewertung sortiert mit Gründen", async () => {
    /* Jev: Tiefbau passt genau, die Bäckerei kaum */
    fakeOpenRouter({ chat: b => fitAnswer(b, l => l.firma.includes("Tiefbau") ? { company: 4, person: 4, need: 3 } : { company: 0, person: 3, need: 0 }) });
    const rows = [
      { co: "Bäckerei Korn", p: "Jan Korn", role: "Inhaber", email: "jan@korn.de", web: "", city: "" },
      { co: "Tiefbau Nord GmbH", p: "", role: "", email: "info@tiefbau-nord.de", web: "", city: "" },
      { co: "Tiefbau Süd GmbH", p: "Eva Stein", role: "Geschäftsführerin", email: "eva.stein@tiefbau-sued.de", web: "", city: "" },
    ];
    expect((await call(POST, { as: me, body: { t: slug, rows, source: "Test" } })).status).toBe(200);
    const got = await list();
    expect(got.map(r => r.company)).toEqual(["Tiefbau Süd GmbH", "Tiefbau Nord GmbH", "Bäckerei Korn"]);
    expect(got[0].ratingInfo!.grade).toBe("A");
    expect(got[1].ratingInfo!.reasons.map(r => r.text)).toContain("Sammeladresse");
  });

  it("Daumen runter senkt die Bewertung sofort, 0 nimmt ihn zurück, anderes wird abgelehnt", async () => {
    const [top] = await list();
    const down = await call(PATCH, { as: me, method: "PATCH", body: { vote: -1 }, ctx: ctx(top.id) });
    expect(down.status).toBe(200);
    const after = (await list()).find(r => r.id === top.id)!;
    expect(after.vote).toBe(-1);
    expect(top.rating! - after.rating!).toBeGreaterThanOrEqual(15);
    await call(PATCH, { as: me, method: "PATCH", body: { vote: 0 }, ctx: ctx(top.id) });
    expect((await list()).find(r => r.id === top.id)!.rating).toBe(top.rating);
    expect((await call(PATCH, { as: me, method: "PATCH", body: { vote: 5 }, ctx: ctx(top.id) })).status).toBe(400);
  });
});
