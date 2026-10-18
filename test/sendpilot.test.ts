import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Webhook } from "svix";
import { db, leads } from "@/db";
import { setInteg } from "@/lib/integrations";
import { linkedinKey } from "@/lib/sendpilot";
import { POST as PUSH } from "@/app/api/sendpilot/route";
import { POST as HOOK } from "@/app/api/sendpilot/webhook/[slug]/route";
import { call, fixtures } from "./helpers";

const fx = fixtures();
const secret = `whsec_${Buffer.from("sendpilot-test-secret-0123456789").toString("base64")}`;
let me: { id: number }, t: { id: number; slug: string }, eva: number, ben: number, max: number;

beforeAll(async () => {
  me = await fx.user();
  t = await fx.tenant(me);
  await setInteg(t.id, "sendpilot", null, { key: "sp_test", secret, workspace: "ws_1" }, "Test");
  [{ id: eva }, { id: ben }, { id: max }] = await db.insert(leads).values([
    { tenantId: t.id, company: "Müller Bau", first: "Eva", last: "Müller", linkedin: "https://de.linkedin.com/in/Eva-Mueller/?locale=de" },
    { tenantId: t.id, company: "Schmidt", first: "Ben", linkedin: "https://www.linkedin.com/in/ben" },
    { tenantId: t.id, company: "Ohne Profil", first: "Max" },
  ]).returning({ id: leads.id });
});
afterAll(() => fx.cleanup());
afterEach(() => { vi.unstubAllGlobals(); });

const status = async (id: number) => (await db.select({ s: leads.status }).from(leads).where(eq(leads.id, id)))[0].s;

function signed(payload: object, key = secret) {
  const raw = JSON.stringify(payload), id = `msg_${Math.random().toString(36).slice(2)}`, ts = new Date();
  const sig = new Webhook(key).sign(id, ts, raw);
  return new Request(`http://localhost/api/sendpilot/webhook/${t.slug}`, { method: "POST", body: raw,
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(Math.floor(ts.getTime() / 1000)), "svix-signature": sig } });
}
const ctx = () => ({ params: Promise.resolve({ slug: t.slug }) });
const event = (eventType: string, linkedinUrl: string, workspaceId = "ws_1") =>
  ({ eventId: `evt_${Math.random()}`, eventType, timestamp: new Date().toISOString(), workspaceId, data: { linkedinUrl, leadId: "l1", campaignId: "c1" } });

describe("SendPilot", () => {
  it("linkedinKey vereinheitlicht Profil-URLs", () => {
    expect(linkedinKey("https://de.linkedin.com/in/Eva-Mueller/?locale=de")).toBe("eva-mueller");
    expect(linkedinKey("linkedin.com/company/acme")).toBe("");
  });

  it("Webhook ohne gültige Signatur wird abgelehnt", async () => {
    const r = await HOOK(signed(event("reply.received", "https://www.linkedin.com/in/ben"), `whsec_${Buffer.from("falsches-secret-0123456789abcdef").toString("base64")}`), ctx());
    expect(r.status).toBe(400);
    expect(await status(ben)).toBe("neu");
  });

  it("Event aus fremdem Workspace ändert nichts", async () => {
    const r = await HOOK(signed(event("reply.received", "https://www.linkedin.com/in/ben", "ws_other")), ctx());
    expect(r.status).toBe(400);
  });

  it("Gesendet setzt angeschrieben, Antwort setzt beantwortet, nie zurück", async () => {
    expect(await (await HOOK(signed(event("connection_request.sent", "https://www.linkedin.com/in/eva-mueller")), ctx())).json()).toEqual({ updated: 1 });
    expect(await status(eva)).toBe("angeschrieben");
    await HOOK(signed(event("reply.received", "https://linkedin.com/in/eva-mueller/")), ctx());
    expect(await status(eva)).toBe("beantwortet");
    expect(await (await HOOK(signed(event("message.sent", "https://www.linkedin.com/in/eva-mueller")), ctx())).json()).toEqual({ updated: 0 });
    expect(await status(eva)).toBe("beantwortet");
  });

  it("Ähnliche Profil-URL trifft nicht den falschen Lead", async () => {
    expect(await (await HOOK(signed(event("reply.received", "https://www.linkedin.com/in/be")), ctx())).json()).toEqual({ updated: 0 });
    expect(await status(ben)).toBe("neu");
  });

  it("Leads mit Profil gehen in die Kampagne, ohne Profil werden übersprungen", async () => {
    const sent: { url: string; body: { campaignId: string; leads: { linkedinUrl: string; firstName: string }[] }; key: string | null }[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      /* the database driver talks over fetch too */
      if (!String(url).startsWith("https://api.sendpilot.ai")) return real(url, init);
      sent.push({ url, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("x-api-key") });
      return Response.json({ success: true, leadsAdded: 1, duplicatesSkipped: 1, invalidEntries: 0 }, { status: 201 });
    }));
    const r = await call(PUSH, { as: me, body: { t: t.slug, campaignId: "c1", leadIds: [eva, ben, max] } });
    expect(r).toEqual({ status: 200, json: { added: 1, duplicates: 1, invalid: 0, skipped: 1 } });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://api.sendpilot.ai/v1/leads");
    expect(sent[0].key).toBe("sp_test");
    expect(sent[0].body.campaignId).toBe("c1");
    expect(sent[0].body.leads.map(l => l.linkedinUrl).sort()).toEqual(["https://www.linkedin.com/in/ben/", "https://www.linkedin.com/in/eva-mueller/"]);
  });

  it("Fremder Mandant kann nichts übergeben", async () => {
    const other = await fx.user();
    expect((await call(PUSH, { as: other, body: { t: t.slug, campaignId: "c1", leadIds: [eva] } })).status).toBe(404);
  });
});
