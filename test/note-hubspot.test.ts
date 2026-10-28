import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, leads, tenants } from "@/db";
import { PATCH } from "@/app/api/leads/[id]/route";
import { setInteg } from "@/lib/integrations";
import { call, fixtures } from "./helpers";

const fx = fixtures();
let me: { id: number }, t: typeof tenants.$inferSelect;

/* only HubSpot is answered here; the database driver talks HTTP too. Returns the calls HubSpot got */
function fakeHubspot(contact: string | null, fail = false) {
  const real = globalThis.fetch, got: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
    const url = String(u);
    if (!url.startsWith("https://api.hubapi.com")) return real(u, init);
    const path = url.slice("https://api.hubapi.com".length);
    got.push({ path, body: JSON.parse(String(init?.body || "{}")) });
    if (path === "/crm/v3/objects/contacts/search") return new Response(JSON.stringify({ results: contact ? [{ id: contact }] : [] }));
    if (fail) return new Response("missing scope", { status: 403 });
    return new Response(JSON.stringify({ id: "n1" }));
  }));
  return got;
}
const lead = async (v: Partial<typeof leads.$inferInsert>) =>
  (await db.insert(leads).values({ tenantId: t.id, company: "Nord Stahl", status: "neu", ...v }).returning())[0];
const patch = (id: number, body: unknown) => call(PATCH, { as: me, method: "PATCH", body, ctx: { params: Promise.resolve({ id: String(id) }) } });

beforeAll(async () => {
  me = await fx.user();
  t = await fx.tenant(me);
  await setInteg(t.id, "hubspot", null, { token: "pat-test" });
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(() => fx.cleanup());

describe("Notiz nach HubSpot", () => {
  it("eine geänderte Notiz kommt als neue Notiz an den Kontakt, HTML maskiert, Zeilen erhalten", async () => {
    const l = await lead({ hsContactId: "501", note: "alt" });
    const got = fakeHubspot(null);
    const { status, json } = await patch(l.id, { note: "Ruft <Montag> an\nwill Demo" });
    expect(status).toBe(200);
    expect(json).toEqual({ hubspot: "ok" });
    const note = got.find(g => g.path === "/crm/v3/objects/notes")!;
    expect(note.body).toMatchObject({ properties: { hs_note_body: "Ruft &lt;Montag&gt; an<br>will Demo" },
      associations: [{ to: { id: "501" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }] });
  });

  it("ohne HubSpot-ID wird der Kontakt über die Adresse gefunden", async () => {
    const l = await lead({ email: "eva@nord-stahl.de" });
    const got = fakeHubspot("777");
    expect((await patch(l.id, { note: "kennt uns von der Messe" })).json).toEqual({ hubspot: "ok" });
    expect(got.find(g => g.path === "/crm/v3/objects/notes")?.body).toMatchObject({ associations: [{ to: { id: "777" } }] });
  });

  it("wer nicht in HubSpot ist, wird dafür nicht angelegt", async () => {
    const l = await lead({ email: "neu@kalt.de" });
    const got = fakeHubspot(null);
    expect((await patch(l.id, { note: "kalter Lead" })).json).toEqual({ hubspot: "kein Kontakt" });
    expect(got.map(g => g.path)).toEqual(["/crm/v3/objects/contacts/search"]);
    expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0].note).toBe("kalter Lead");
  });

  it("ein HubSpot-Fehler wird gemeldet, die Notiz ist im Portal trotzdem gespeichert", async () => {
    const l = await lead({ hsContactId: "502" });
    fakeHubspot(null, true);
    const { status, json } = await patch(l.id, { note: "wichtig" });
    expect(status).toBe(200);
    expect(json.hubspot).toMatch(/^Fehler: HubSpot 403/);
    expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0].note).toBe("wichtig");
  });

  it("ohne geänderte oder mit leerer Notiz geht nichts an HubSpot", async () => {
    const l = await lead({ hsContactId: "503", note: "gleich" });
    const got = fakeHubspot(null);
    await patch(l.id, { note: "gleich", role: "Einkauf" });
    await patch(l.id, { note: "" });
    expect(got).toHaveLength(0);
  });
});
