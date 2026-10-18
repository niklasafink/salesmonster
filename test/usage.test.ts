import { describe, expect, it, vi } from "vitest";

const rows: Record<string, unknown>[] = [];
vi.mock("@/db", () => ({ aiUsage: {}, db: { insert: () => ({ values: (v: Record<string, unknown>) => { rows.push(v); return Promise.resolve(); } }) } }));
const { spend, track } = await import("@/lib/usage");

describe("track", () => {
  it("counts nested actions for the outer one and same-kind items into it", async () => {
    rows.length = 0;
    await track({ tenantId: 1, kind: "anreicherung", ref: "enrich:7" }, async () => {
      for (let i = 0; i < 3; i++) await track({ tenantId: 1, kind: "anreicherung" }, async m => { spend(0.002); m.count(1); });
      await track({ tenantId: 1, kind: "bewertung" }, async m => { spend(0.001); m.count(10); });
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "anreicherung", ref: "enrich:7", items: 3, calls: 4, cost: 7000, unpriced: 0 });
  });

  it("writes nothing without AI calls and counts unpriced calls", async () => {
    rows.length = 0;
    await track({ tenantId: 1, kind: "import" }, async () => {});
    expect(rows).toHaveLength(0);
    await track({ tenantId: 1, kind: "import" }, async () => { spend(null); });
    expect(rows[0]).toMatchObject({ calls: 1, unpriced: 1, cost: 0 });
  });

  it("a late call after the action ended gets its own row", async () => {
    rows.length = 0;
    let late: Promise<void> = Promise.resolve();
    await track({ tenantId: 1, kind: "recherche" }, async () => { spend(0.01); late = new Promise(r => setTimeout(() => { spend(0.5); r(); }, 5)); });
    await late;
    expect(rows.map(r => r.cost)).toEqual([10000, 500000]);
  });
});
