import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, leads, messages, templates } from "@/db";
import { setInteg } from "@/lib/integrations";
import { POST as SCORE } from "@/app/api/messages/[id]/score/route";
import { POST as IMPROVE } from "@/app/api/messages/[id]/improve/route";
import { call, fakeOpenRouter, fixtures, jevMail } from "./helpers";

const fx = fixtures();
let me: { id: number }, other: { id: number }, msgId: number;
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

beforeAll(async () => {
  me = await fx.user(); other = await fx.user();
  const t = await fx.tenant(me);
  await setInteg(t.id, "openrouter", me.id, { key: "sk-or-test" });
  await db.insert(templates).values({ tenantId: t.id, key: "A", name: "Anlass", subject: "Kanalbau {{firma}}", body: "{{anrede}}\n\nSie bauen {{aufhaenger}}. Darf ich Ihnen drei passende Ausschreibungen schicken?\n\nViele Grüße\n{{absender}}" });
  const [l] = await db.insert(leads).values({ tenantId: t.id, company: "Albers", first: "Katrin", last: "Albers", salutation: "Frau", email: "k@albers.de", hook: "den Regenwasserkanal in Bielefeld", status: "freigabe" }).returning();
  const [m] = await db.insert(messages).values({ tenantId: t.id, leadId: l.id, leadIds: [l.id], to: l.email, batchDate: "2026-10-18", variant: "A" }).returning();
  msgId = m.id;
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(() => fx.cleanup());

describe("Score eines Entwurfs", () => {
  it("Jev bewertet die gefüllte Vorlage, Regeln ziehen ab", async () => {
    const seen = fakeOpenRouter({ jev: () => jevMail(3) });
    const r = await call(SCORE, { as: me, body: {}, ctx: ctx(msgId) });
    expect(r).toEqual({ status: 200, json: { total: 83, issues: [] } });
    expect(String(seen[0].body.state)).toContain("Sie bauen den Regenwasserkanal in Bielefeld");
  });

  it("gleicher Text: kein neuer Jev-Aufruf", async () => {
    const seen = fakeOpenRouter({ jev: () => jevMail(1) });
    expect((await call(SCORE, { as: me, body: {}, ctx: ctx(msgId) })).json.total).toBe(83);
    expect(seen).toHaveLength(0);
  });

  it("bearbeiteter Text aus der Freigabe wird neu bewertet", async () => {
    fakeOpenRouter({ jev: () => jevMail(3) });
    const long = Array.from({ length: 120 }, () => "Wort").join(" ");
    const r = await call(SCORE, { as: me, body: { subject: "Kanalbau", body: long }, ctx: ctx(msgId) });
    expect(r.json).toEqual({ total: 58, issues: ["120 Wörter"] });
  });

  it("fremde Nachricht nicht gefunden", async () => {
    expect((await call(SCORE, { as: other, body: {}, ctx: ctx(msgId) })).status).toBe(404);
  });
});

describe("Verbessern", () => {
  const variants = (...bodies: string[]) => "```json\n" + JSON.stringify({ variants: bodies.map(b => ({ subject: "Kanal Bielefeld", body: b })) }) + "\n```";
  /* Jev likes texts that mention "drei Ausschreibungen aus Bielefeld" */
  const likes = () => fakeOpenRouter({ jev: state => jevMail(state.includes("aus Bielefeld") ? 4 : 2), chat: () => variants("Guten Tag Frau Albers,\n\nSie bauen den Kanal. Darf ich Ihnen drei Ausschreibungen schicken?\n\nGrüße", "Guten Tag Frau Albers,\n\nfür Ihren Kanal habe ich drei Ausschreibungen aus Bielefeld. Soll ich sie schicken?\n\nGrüße") });

  it("Grok schreibt zwei kurze Fassungen, die beste wird übernommen", async () => {
    const seen = likes();
    await call(SCORE, { as: me, body: { subject: "Kanalbau Albers", body: "Guten Tag Frau Albers,\n\nSie bauen den Regenwasserkanal in Bielefeld. Darf ich Ihnen drei Ausschreibungen schicken?\n\nGrüße" }, ctx: ctx(msgId) });
    const r = await call(IMPROVE, { as: me, body: { subject: "Kanalbau Albers", body: "Guten Tag Frau Albers,\n\nSie bauen den Regenwasserkanal in Bielefeld. Darf ich Ihnen drei Ausschreibungen schicken?\n\nGrüße" }, ctx: ctx(msgId) });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ improved: true, subject: "Kanal Bielefeld", score: { total: 100 } });
    expect(r.json.body).toContain("aus Bielefeld");
    const chat = seen.find(x => x.url.endsWith("/chat/completions"))!;
    expect(chat.body.model).toBe("x-ai/grok-4.7");
    expect(JSON.stringify(chat.body.messages)).toContain("unter 100 Wörtern");
  });

  it("keine bessere Fassung: Text bleibt", async () => {
    fakeOpenRouter({ jev: () => jevMail(2), chat: () => variants("Guten Tag,\n\nkurz. Interesse?\n\nGrüße") });
    const r = await call(IMPROVE, { as: me, body: { subject: "Kanal Bielefeld", body: "Guten Tag Frau Albers,\n\nfür Ihren Kanal habe ich drei Ausschreibungen aus Bielefeld. Soll ich sie schicken?\n\nGrüße" }, ctx: ctx(msgId) });
    expect(r.json).toMatchObject({ improved: false });
  });
});
