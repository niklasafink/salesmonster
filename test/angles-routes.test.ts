import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, tenants } from "@/db";
import { GET, POST } from "@/app/api/angles/route";
import { PATCH } from "@/app/api/angles/[id]/route";
import { call, fixtures } from "./helpers";

const fx = fixtures();
let me: { id: number }, other: { id: number }, slug: string;
type Row = { id: number; label: string; origin: string; active: boolean; leads: number; score: number };
const list = async () => (await call(GET, { as: me, path: `/api/angles?t=${slug}` })).json.rows as Row[];
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

beforeAll(async () => {
  me = await fx.user(); other = await fx.user();
  const t = await fx.tenant(me); slug = t.slug;
  await db.update(tenants).set({ settings: { prompt: "Angebot.\nBranchen: Tiefbau, Kanalbau", leadsPerDay: 10, cooldownDays: 30 } }).where(eq(tenants.id, t.id));
});
afterAll(() => fx.cleanup());

describe("Suchrichtungen im Portal", () => {
  it("Start aus den Branchen des Prompts, mit Zahlen", async () => {
    const rows = await list();
    expect(rows.map(r => [r.label, r.origin, r.active, r.leads])).toEqual([["Tiefbau", "start", true, 0], ["Kanalbau", "start", true, 0]]);
    expect(rows[0].score).toBeCloseTo(0.04, 3);
    expect((await list()).length).toBe(2);
  });

  it("eigene Richtung anlegen und ausschalten; fremde nicht", async () => {
    const r = await call(POST, { as: me, body: { t: slug, label: " Brückenbau NRW ", query: "Brückenbaufirmen mit neuen Aufträgen" } });
    expect(r.status).toBe(200);
    expect((await list()).find(x => x.id === r.json.id)).toMatchObject({ label: "Brückenbau NRW", origin: "nutzer", active: true });
    expect((await call(PATCH, { as: me, method: "PATCH", body: { active: false }, ctx: ctx(r.json.id) })).status).toBe(200);
    expect((await list()).find(x => x.id === r.json.id)!.active).toBe(false);
    expect((await call(PATCH, { as: other, method: "PATCH", body: { active: true }, ctx: ctx(r.json.id) })).status).toBe(404);
    expect((await call(POST, { as: me, body: { t: slug, label: "  " } })).status).toBe(400);
  });
});
