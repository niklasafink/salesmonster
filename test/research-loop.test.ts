import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, tenants } from "@/db";
import { GET as LEADS } from "@/app/api/leads/route";
import { GET as ANGLES } from "@/app/api/angles/route";
import { setInteg } from "@/lib/integrations";
import { researchLoop } from "@/lib/strategy";
import { call, fakeOpenRouter, fitAnswer, fixtures, isFit } from "./helpers";

const fx = fixtures();
let me: { id: number }, t: typeof tenants.$inferSelect;
/* 18:00 in Berlin: every round of the day is due */
const EVENING = new Date("2026-10-18T16:00:00Z");

beforeAll(async () => {
  me = await fx.user();
  const row = await fx.tenant(me);
  [t] = await db.update(tenants).set({ settings: { prompt: "Wir verkaufen Ausschreibungsrecherche an Tiefbaufirmen.", leadsPerDay: 2, cooldownDays: 30, roundsPerDay: 2 } }).where(eq(tenants.id, row.id)).returning();
  await setInteg(t.id, "openrouter", me.id, { key: "sk-or-test", model: "anthropic/claude-sonnet-5.5" });
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(() => fx.cleanup());

describe("Laufende Recherche", () => {
  it("macht die fälligen Runden, ordnet Leads ihrer Suchrichtung zu, bewertet sie und ändert die Strategie", async () => {
    let n = 0;
    const seen = fakeOpenRouter({
      chat: b => isFit(b) ? fitAnswer(b, () => ({ company: 3, person: 3, need: 3 }))
        : b.messages[0].content.includes("Recherche-Assistent")
        ? "```json\n" + JSON.stringify({ leads: [1, 2].map(() => { n++; return { company: `Tiefbau ${n} GmbH`, first: "Eva", last: `Stein${n}`, role: "Geschäftsführerin", email: `eva@tiefbau${n}.de`, hook: "der neue Auftrag" }; }) }) + "\n```"
        : "```json\n" + JSON.stringify({ angles: [{ label: "Kanalbau NRW", query: "Kanalbaufirmen in NRW" }, { label: "Straßenbau Bayern", query: "Straßenbau mit neuen Losen" }] }) + "\n```",
    });
    expect(await researchLoop(t, EVENING)).toEqual({ rounds: 1, added: 2 });
    expect(await researchLoop(t, EVENING)).toEqual({ rounds: 1, added: 2 });

    const leads = (await call(LEADS, { as: me, path: `/api/leads?t=${t.slug}` })).json.rows as { company: string; angleId: number | null; rating: number | null; fit: number | null }[];
    expect(leads).toHaveLength(4);
    expect(leads.every(l => l.angleId !== null && l.rating !== null && l.fit === 3)).toBe(true);

    const angles = (await call(ANGLES, { as: me, path: `/api/angles?t=${t.slug}` })).json.rows as { label: string; origin: string }[];
    expect(angles.map(a => [a.label, a.origin])).toEqual([["Allgemein", "start"], ["Kanalbau NRW", "ki"], ["Straßenbau Bayern", "ki"]]);
    expect(seen.some(s => JSON.stringify(s.body).includes("Bisherige Suchrichtungen"))).toBe(true);
  });

  it("danach ist für heute nichts mehr fällig; 0 Runden = aus", async () => {
    fakeOpenRouter({});
    expect(await researchLoop(t, EVENING)).toEqual({ rounds: 0, added: 0 });
    expect(await researchLoop({ ...t, settings: { ...t.settings, roundsPerDay: 0 } }, EVENING)).toEqual({ rounds: 0, added: 0 });
  });
});
