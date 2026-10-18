import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, leads } from "@/db";
import { POST } from "@/app/api/leads/enrich/route";
import { call, fixtures } from "./helpers";

/* the web search is faked: it records which fields it was asked for and finds only a phone number */
const asked: string[] = [];
vi.mock("@/lib/ai", async orig => ({ ...await orig<typeof import("@/lib/ai")>(), aiFor: async () => ({ provider: "anthropic", key: "k" }) }));
vi.mock("@/lib/claude", async orig => ({
  ...await orig<typeof import("@/lib/claude")>(),
  ask: async ({ prompt }: { prompt: string }) => { asked.push(prompt.split("\n")[0]); return '```json\n{"phone":"+49 711 123456"}\n```'; },
}));

const fx = fixtures();
let user: { id: number }, slug: string, tenantId: number;
beforeAll(async () => { user = await fx.user(); const t = await fx.tenant(user); slug = t.slug; tenantId = t.id; });
afterAll(() => fx.cleanup());
beforeEach(() => { asked.length = 0; });

const lead = async () => (await db.insert(leads).values({ tenantId, company: "Testbau GmbH", first: "Max", last: "Muster" }).returning())[0];
const enrich = (id: number, again?: boolean) => call(POST, { as: user, body: { t: slug, ids: [id], fields: ["email", "phone"], ...(again === undefined ? {} : { again }) } }).then(r => r.json);

describe("Anreichern", () => {
  it("sagt je Lead, was gefunden wurde und was nicht, und merkt sich die Lücken", async () => {
    const l = await lead();
    const { results: [r] } = await enrich(l.id);
    expect(r).toMatchObject({ id: l.id, found: { phone: "+49 711 123456" }, missed: ["email"] });
    const [row] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(row.phone).toBe("+49 711 123456");
    expect(row.enrichMiss.email).toBeTruthy();
  });

  it("sucht ein früher erfolgloses Feld nur, wenn erneut prüfen gewählt ist", async () => {
    const l = await lead();
    await db.update(leads).set({ enrichMiss: { email: new Date().toISOString() } }).where(eq(leads.id, l.id));
    const { results: [r] } = await enrich(l.id);
    expect(asked[0]).not.toContain("E-Mail");
    expect(r.missed).toEqual([]);
    expect(r.found.phone).toBeTruthy();

    await db.update(leads).set({ phone: "" }).where(eq(leads.id, l.id));
    asked.length = 0;
    const { results: [again] } = await enrich(l.id, true);
    expect(asked[0]).toContain("E-Mail");
    expect(again.missed).toEqual(["email"]);
  });

  it("sucht gar nicht, wenn nur früher erfolglose Felder fehlen", async () => {
    const l = await lead();
    await db.update(leads).set({ phone: "+49 1", enrichMiss: { email: new Date().toISOString() } }).where(eq(leads.id, l.id));
    const { results: [r] } = await enrich(l.id);
    expect(asked).toEqual([]);
    expect(r).toMatchObject({ found: {}, missed: [] });
  });
});
