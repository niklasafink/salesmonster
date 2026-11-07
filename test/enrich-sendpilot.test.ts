import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, leads } from "@/db";
import { setInteg } from "@/lib/integrations";
import { sameName } from "@/lib/sendpilot";
import { POST } from "@/app/api/leads/enrich/route";
import { call, connectorTokens, fixtures, mcp } from "./helpers";

/* no AI in this file: whatever is found comes from SendPilot; the web search would show up in asked */
const asked: string[] = [];
vi.mock("@/lib/ai", async orig => ({ ...await orig<typeof import("@/lib/ai")>(), aiFor: async () => null }));
vi.mock("@/lib/claude", async orig => ({ ...await orig<typeof import("@/lib/claude")>(), ask: async ({ prompt }: { prompt: string }) => { asked.push(prompt); return "{}"; } }));

/* SendPilot at the network edge; everything else (Neon, the in-process MCP) passes through */
type Hit = Record<string, string>;
let hits: Hit[] = [], searches: { filters: Record<string, unknown>; limit: number }[] = [];
function fakeSendPilot() {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://mcp.sendpilot.ai")) return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    if (!url.startsWith("https://api.sendpilot.ai")) return real(input, init);
    const path = new URL(url).pathname;
    if (path === "/v1/lead-database/searches") { searches.push(JSON.parse(String(init?.body))); return Response.json({ id: `s${searches.length}` }); }
    if (path.endsWith("/status")) return Response.json({ id: "s", status: "completed" });
    if (path.endsWith("/results")) return Response.json({ results: hits, pagination: { has_more: false } });
    return new Response("not found", { status: 404 });
  });
}

const fx = fixtures();
let me: { id: number }, sp: { id: number; slug: string }, plain: { id: number; slug: string };
beforeAll(async () => {
  me = await fx.user();
  sp = await fx.tenant(me); plain = await fx.tenant(me);
  await setInteg(sp.id, "sendpilot", null, { key: "sp_test", secret: "whsec_x", workspace: "ws_1" }, "Test");
});
afterAll(() => fx.cleanup());
beforeEach(() => { asked.length = 0; hits = []; searches = []; fakeSendPilot(); });
afterEach(() => { vi.unstubAllGlobals(); });

const lead = async (tenantId: number, v: Partial<typeof leads.$inferInsert> = {}) =>
  (await db.insert(leads).values({ tenantId, company: "Müller Bau GmbH", first: "Eva", last: "Müller", website: "https://www.mueller-bau.de", ...v }).returning())[0];
const row = async (id: number) => (await db.select().from(leads).where(eq(leads.id, id)))[0];
const enrich = (slug: string, id: number, fields: string[]) => call(POST, { as: me, body: { t: slug, ids: [id], fields } });

describe("Anreichern über SendPilot", () => {
  it("Namen in verschiedenen Schreibweisen gelten als gleich", () => {
    expect(sameName("Müller", "Mueller")).toBe(true);
    expect(sameName("Müller", "MULLER")).toBe(true);
    expect(sameName("Müller", "Maier")).toBe(false);
  });

  it("holt das LinkedIn-Profil ohne KI, sucht nach Name und Domain, höchstens ein Treffer", async () => {
    hits = [{ firstName: "Eva", lastName: "Mueller", title: "Geschäftsführerin", linkedinUrl: "https://de.linkedin.com/in/eva-mueller/?trk=x" }];
    const l = await lead(sp.id);
    const r = await enrich(sp.slug, l.id, ["linkedin"]);
    expect(r.status).toBe(200);
    expect(r.json.results[0]).toMatchObject({ found: { linkedin: "https://de.linkedin.com/in/eva-mueller/" }, missed: [] });
    expect(searches).toEqual([expect.objectContaining({ limit: 1, filters: { companyDomains: ["mueller-bau.de"], name: "Eva Müller" } })]);
    expect(asked).toEqual([]);
    expect((await row(l.id)).linkedin).toBe("https://de.linkedin.com/in/eva-mueller/");
  });

  it("nimmt keinen Treffer mit anderem Nachnamen und merkt sich die Lücke", async () => {
    hits = [{ firstName: "Eva", lastName: "Maier", linkedinUrl: "https://www.linkedin.com/in/eva-maier" }];
    const l = await lead(sp.id);
    const { json } = await enrich(sp.slug, l.id, ["linkedin"]);
    expect(json.results[0]).toMatchObject({ found: {}, missed: ["linkedin"] });
    expect((await row(l.id)).enrichMiss.linkedin).toBeTruthy();
  });

  it("ohne Person sucht SendPilot die Geschäftsführung und füllt Name, Funktion und Profil", async () => {
    hits = [{ full_name: "Jan van Dijk", job_title: "Geschäftsführer", linkedin_url: "https://www.linkedin.com/in/janvandijk" }];
    const l = await lead(sp.id, { first: "", last: "", website: "" });
    const { json } = await enrich(sp.slug, l.id, ["person", "linkedin"]);
    expect(searches[0].filters).toMatchObject({ companies: ["Müller Bau GmbH"], jobTitles: expect.arrayContaining(["Geschäftsführer"]) });
    expect(json.results[0].found).toMatchObject({ first: "Jan van", last: "Dijk", role: "Geschäftsführer", linkedin: "https://www.linkedin.com/in/janvandijk" });
  });

  it("ohne Person und ohne Feld Person fragt es SendPilot gar nicht erst", async () => {
    const l = await lead(sp.id, { first: "", last: "" });
    const { json } = await enrich(sp.slug, l.id, ["linkedin"]);
    expect(searches).toEqual([]);
    expect(json.results[0]).toMatchObject({ found: {}, missed: [] });
  });

  it("andere Felder brauchen weiter eine KI", async () => {
    const l = await lead(sp.id);
    expect((await enrich(sp.slug, l.id, ["linkedin", "email"])).status).toBe(400);
    expect((await enrich(plain.slug, l.id, ["linkedin"])).status).toBe(400);
  });
});

describe("leads_enrich (MCP)", () => {
  let c: Awaited<ReturnType<typeof mcp>>;
  beforeAll(async () => { fakeSendPilot(); c = await mcp((await connectorTokens(me)).access_token); });
  afterAll(async () => { await c?.close(); });

  type Out = { via: string; leads: { id: number; todo: string[]; sendpilot?: { found: Record<string, string> } }[]; howTo: string };

  it("mit SendPilot: LinkedIn kommt von dort, der Rest bleibt für Claude, ohne bezahlte Websuche", async () => {
    hits = [{ firstName: "Eva", lastName: "Müller", linkedinUrl: "https://www.linkedin.com/in/eva-mueller" }];
    const l = await lead(sp.id);
    const out = await c.tool<Out>("leads_enrich", { tenant: sp.slug, ids: [l.id], fields: ["linkedin", "email"] });
    expect(out.via).toBe("sendpilot");
    expect(out.leads[0]).toMatchObject({ id: l.id, sendpilot: { found: { linkedin: "https://www.linkedin.com/in/eva-mueller" } }, todo: ["email"] });
    expect(asked).toEqual([]);
  });

  it("ohne SendPilot steht alles in todo, leads_update schreibt Treffer und Lücken", async () => {
    const l = await lead(plain.id);
    const out = await c.tool<Out>("leads_enrich", { tenant: plain.slug, ids: [l.id], fields: ["linkedin", "email"] });
    expect(out.via).toBe("claude");
    expect(out.leads[0].todo).toEqual(["linkedin", "email"]);
    expect(searches).toEqual([]);

    await expect(c.tool("leads_update", { tenant: plain.slug, updates: [{ id: l.id, linkedin: "https://www.linkedin.com/company/mueller-bau" }] })).rejects.toThrow(/persönliches LinkedIn-Profil/);
    await c.tool("leads_update", { tenant: plain.slug, updates: [{ id: l.id, linkedin: "linkedin.com/in/eva-mueller?x=1", missed: ["email"] }] });
    const r = await row(l.id);
    expect(r.linkedin).toBe("https://linkedin.com/in/eva-mueller");
    expect(r.enrichMiss.email).toBeTruthy();
    const next = await c.tool<Out>("leads_enrich", { tenant: plain.slug, ids: [l.id], fields: ["linkedin", "email"] });
    expect(next.leads[0].todo).toEqual([]);
  });
});
