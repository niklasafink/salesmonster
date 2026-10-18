import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, enrichJobs, leads } from "@/db";
import { GET, PATCH, POST } from "@/app/api/leads/enrich/jobs/route";
import { work } from "@/lib/enrich-jobs";
import { call, fixtures } from "./helpers";

/* the web search is faked and finds only a phone number */
vi.mock("@/lib/ai", async orig => ({ ...await orig<typeof import("@/lib/ai")>(), aiFor: async () => ({ provider: "anthropic", key: "k" }) }));
vi.mock("@/lib/claude", async orig => ({ ...await orig<typeof import("@/lib/claude")>(), ask: async () => '```json\n{"phone":"+49 711 123456"}\n```' }));

const fx = fixtures();
let user: { id: number }, slug: string, tenantId: number;
beforeAll(async () => { user = await fx.user(); const t = await fx.tenant(user); slug = t.slug; tenantId = t.id; });
afterAll(() => fx.cleanup());

const lead = async (company: string) => (await db.insert(leads).values({ tenantId, company, first: "Max", last: "Muster" }).returning())[0];
const current = () => call(GET, { as: user, path: `/?t=${slug}` }).then(r => r.json.job);

describe("Anreichern im Hintergrund", () => {
  it("arbeitet alle Leads ab, ohne dass die Seite offen bleibt, und zeigt das Ergebnis einmal", async () => {
    const a = await lead("Alpha GmbH"), b = await lead("Beta GmbH");
    const { json } = await call(POST, { as: user, body: { t: slug, ids: [a.id, b.id], fields: ["email", "phone"] } });
    expect(json.job).toMatchObject({ total: 2 });
    const j = await current();
    expect(j).toMatchObject({ status: "fertig", done: 2, found: 2 });
    expect(j.results.map((r: { name: string }) => r.name).sort()).toEqual(["Max Muster, Alpha GmbH", "Max Muster, Beta GmbH"]);
    expect(j.results[0]).toMatchObject({ found: { phone: "+49 711 123456" }, missed: ["email"] });
    const [row] = await db.select().from(leads).where(eq(leads.id, a.id));
    expect(row.phone).toBe("+49 711 123456");
    await call(PATCH, { as: user, method: "PATCH", body: { t: slug, id: j.id, action: "seen" } });
    expect(await current()).toBeNull();
  });

  it("ein gestoppter Lauf sucht nicht weiter", async () => {
    const c = await lead("Gamma GmbH");
    const [j] = await db.insert(enrichJobs).values({ tenantId, userId: user.id, items: [{ id: c.id, name: "Gamma" }], fields: ["phone"] }).returning();
    await call(PATCH, { as: user, method: "PATCH", body: { t: slug, id: j.id, action: "stop" } });
    await work(j.id, "http://localhost");
    const [after] = await db.select().from(enrichJobs).where(eq(enrichJobs.id, j.id));
    expect(after).toMatchObject({ status: "gestoppt", done: 0, next: 0 });
  });

  it("fremde Mandanten sehen den Lauf nicht", async () => {
    const other = await fx.user();
    const r = await call(GET, { as: other, path: `/?t=${slug}` });
    expect(r.status).toBe(404);
  });
});
