import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, leads, messages, tenants } from "@/db";
import { attachCompanies } from "@/lib/companies";
import { channelOf } from "@/lib/lead-rating";
import { removeInteg, setInteg } from "@/lib/integrations";
import { mailQueue, nextUp } from "@/lib/queue";
import { PUT as QUEUE } from "@/app/api/leads/queue/route";
import { GET as LIST } from "@/app/api/leads/route";
import { PATCH as LEAD } from "@/app/api/leads/[id]/route";
import { POST as PUSH } from "@/app/api/sendpilot/route";
import { call, fixtures } from "./helpers";

const fx = fixtures();
type T = typeof tenants.$inferSelect;
let me: { id: number }, t: T;
const ids: Record<string, number> = {};
const LI = (h: string) => `https://www.linkedin.com/in/${h}`;

beforeAll(async () => {
  me = await fx.user();
  t = await fx.tenant(me);
  const rows = await db.insert(leads).values([
    { tenantId: t.id, company: "Alpha GmbH", first: "Anna", last: "A", email: "anna@alpha.de", linkedin: LI("anna"), rating: 90 },
    { tenantId: t.id, company: "Beta GmbH", first: "Bert", last: "B", email: "info@beta.de", emailType: "info", linkedin: LI("bert"), rating: 80 },
    { tenantId: t.id, company: "Gamma GmbH", first: "Gina", last: "G", email: "gina@gamma.de", rating: 70 },
    { tenantId: t.id, company: "Gamma GmbH", first: "Gus", last: "G", linkedin: LI("gus"), rating: 60 },
    { tenantId: t.id, company: "Delta GmbH", first: "Dora", last: "D", email: "dora@delta.de", rating: 50 },
  ]).returning({ id: leads.id, first: leads.first });
  for (const r of rows) ids[r.first] = r.id;
  await attachCompanies(t.id);
});
afterAll(() => fx.cleanup());
afterEach(() => { vi.unstubAllGlobals(); });

const queue = async () => (await mailQueue((await db.select().from(tenants).where(eq(tenants.id, t.id)))[0])).map(q => q.id);

describe("Kanal je Lead", () => {
  it("persönliche Adresse → E-Mail, Sammeladresse oder keine E-Mail → LinkedIn, Hand schlägt Empfehlung", () => {
    expect(channelOf({ email: "anna@alpha.de", emailType: "person", linkedin: LI("anna") }).ch).toBe("mail");
    expect(channelOf({ email: "info@beta.de", emailType: "info", linkedin: LI("bert") }).ch).toBe("linkedin");
    expect(channelOf({ email: "info@beta.de", emailType: "info", linkedin: "" }).ch).toBe("mail");
    expect(channelOf({ email: "", emailType: "person", linkedin: LI("gus") }).ch).toBe("linkedin");
    expect(channelOf({ email: "", emailType: "person", linkedin: "" }).ch).toBe("none");
    expect(channelOf({ email: "anna@alpha.de", emailType: "person", linkedin: LI("anna") }, ["alpha.de"]).ch).toBe("linkedin");
    expect(channelOf({ email: "anna@alpha.de", emailType: "person", linkedin: LI("anna"), channel: "linkedin" })).toMatchObject({ ch: "linkedin", manual: true });
    expect(channelOf({ email: "", emailType: "person", linkedin: LI("gus"), channel: "mail" }).ch).toBe("linkedin");
  });

  it("Kanal von Hand setzen, Unsinn wird abgelehnt", async () => {
    expect((await call(LEAD, { as: me, method: "PATCH", body: { channel: "fax" }, ctx: { params: Promise.resolve({ id: String(ids.Dora) }) } })).status).toBe(400);
    expect((await call(LEAD, { as: me, method: "PATCH", body: { channel: "mail" }, ctx: { params: Promise.resolve({ id: String(ids.Dora) }) } })).status).toBe(200);
    expect((await db.select({ c: leads.channel }).from(leads).where(eq(leads.id, ids.Dora)))[0].c).toBe("mail");
  });
});

describe("Versand-Warteschlange", () => {
  it("ohne SendPilot: alle offenen Leads nach Bewertung", async () => {
    expect(await queue()).toEqual([ids.Anna, ids.Bert, ids.Gina, ids.Gus, ids.Dora]);
  });

  it("nextUp zählt Firmen, nicht Personen", async () => {
    const q = (await mailQueue((await db.select().from(tenants).where(eq(tenants.id, t.id)))[0]));
    expect(nextUp(q, 3)).toEqual([ids.Anna, ids.Bert, ids.Gina, ids.Gus]);
  });

  it("mit SendPilot fallen LinkedIn-Leads aus dem Mail-Lauf", async () => {
    await setInteg(t.id, "sendpilot", null, { key: "sp_test", secret: "", workspace: "ws_1" });
    expect(await queue()).toEqual([ids.Anna, ids.Gina, ids.Dora]);
    await removeInteg(t.id, "sendpilot", null);
  });

  it("Drag and Drop legt die Reihenfolge fest, der Rest folgt nach Bewertung", async () => {
    expect((await call(QUEUE, { as: me, method: "PUT", body: { t: t.slug, ids: [ids.Dora, ids.Anna] } })).status).toBe(200);
    expect(await queue()).toEqual([ids.Dora, ids.Anna, ids.Bert, ids.Gina, ids.Gus]);
    /* reading the list rates every lead; without the AI's fit, Gina's personal address beats Bert's front desk inbox */
    const { json } = await call(LIST, { as: me, path: `/api/leads?t=${t.slug}` });
    expect(json.order).toEqual([ids.Dora, ids.Anna, ids.Gina, ids.Bert, ids.Gus]);
    expect(json.next.slice(0, 2)).toEqual([ids.Dora, ids.Anna]);
    expect(json.rows.find((r: { id: number }) => r.id === ids.Bert).channelRec.ch).toBe("linkedin");
  });

  it("fremder Mandant kann die Reihenfolge nicht ändern", async () => {
    const other = await fx.user();
    expect((await call(QUEUE, { as: other, method: "PUT", body: { t: t.slug, ids: [ids.Gus] } })).status).toBe(404);
  });

  it("an SendPilot übergeben: Person und ihre Firma raus aus dem Mail-Lauf, wartende Entwürfe weg", async () => {
    await setInteg(t.id, "sendpilot", null, { key: "sp_test", secret: "", workspace: "ws_1" });
    const [m] = await db.insert(messages).values({ tenantId: t.id, leadId: ids.Gina, leadIds: [ids.Gina, ids.Gus], to: "gina@gamma.de", batchDate: "2026-10-19", variant: "A", status: "freigegeben" }).returning({ id: messages.id });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => String(url).startsWith("https://api.sendpilot.ai")
      ? Response.json({ success: true, leadsAdded: 1, duplicatesSkipped: 0, invalidEntries: 0 }, { status: 201 }) : real(url, init)));
    expect((await call(PUSH, { as: me, body: { t: t.slug, campaignId: "c1", leadIds: [ids.Gus] } })).status).toBe(200);
    expect(await db.select().from(messages).where(eq(messages.id, m.id))).toEqual([]);
    await removeInteg(t.id, "sendpilot", null);
    const q = await queue();
    expect(q).not.toContain(ids.Gus);
    expect(q).not.toContain(ids.Gina);
    expect(q).toContain(ids.Anna);
  });
});
