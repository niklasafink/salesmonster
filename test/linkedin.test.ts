import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, leads, liActions, liEnrollments, liSenders, messages } from "@/db";
import { claim, enroll, issueSender, listPeople, renderText, report, saveCampaign, setCampaignStatus, STALE_MIN, type Claim, type Sender, type WorkerAction } from "@/lib/linkedin";
import { connectorTokens, fixtures, mcp } from "./helpers";

const f = fixtures();
afterAll(() => f.cleanup());

/* Wednesday 10:00 Berlin; every step moves the clock past the longest pause */
const T0 = Date.parse("2026-11-18T09:00:00Z");
let clock = T0;
const tick = (min = 10) => new Date(clock += min * 60_000);
const tag = () => Math.random().toString(36).slice(2, 10);

async function sender(id: number): Promise<Sender> { return (await db.select().from(liSenders).where(eq(liSenders.id, id)))[0]; }
const action = (c: Claim): WorkerAction => { if (!("action" in c)) throw new Error(`kein Auftrag: ${c.reason}`); return c.action; };
const enr = async (leadId: number) => (await db.select().from(liEnrollments).where(eq(liEnrollments.leadId, leadId)))[0];

async function lead(tenantId: number, v: Partial<typeof leads.$inferInsert> = {}) {
  const [l] = await db.insert(leads).values({ tenantId, company: "Muster Bank AG", first: "Ida", last: "Muster", role: "Compliance Officer",
    linkedin: `https://www.linkedin.com/in/test-${tag()}/`, ...v }).returning();
  return l;
}

describe("LinkedIn-Kampagnen", () => {
  let user: { id: number }, t: { id: number; slug: string }, other: { id: number }, sid: number;

  beforeAll(async () => {
    user = await f.user();
    t = await f.tenant(user);
    other = await f.tenant(user);
    sid = (await issueSender(user.id)).sender.id;
    /* invites first, quiet pauses */
    await db.update(liSenders).set({ limits: { gapMin: 5, gapMax: 6, invites: 50, weekInvites: 200 } }).where(eq(liSenders.id, sid));
  });

  it("füllt Platzhalter und meldet leere", () => {
    expect(renderText("Hallo {{vorname}}, {{firma}}", { first: "Ida", last: "M", company: "X AG", role: "", hook: "" })).toEqual({ text: "Hallo Ida, X AG", missing: [] });
    expect(renderText("Zu {{aufhaenger}}", { first: "Ida", last: "M", company: "X", role: "", hook: "" }).missing).toEqual(["aufhaenger"]);
  });

  it("lehnt unbekannte Platzhalter und zu lange Notizen ab", async () => {
    await expect(saveCampaign(user.id, t.id, { name: "x", note: "Hi {{anrede}}", followups: [] })).rejects.toThrow(/Platzhalter/);
    await expect(saveCampaign(user.id, t.id, { name: "x", note: "a".repeat(201), followups: [] })).rejects.toThrow(/Zeichen/);
  });

  it("nimmt jede Person nur einmal auf, über Kampagnen und Mandanten hinweg", async () => {
    const c1 = await saveCampaign(user.id, t.id, { name: "Nur Anfrage", note: "Hallo {{vorname}}, gern vernetzt.", followups: [] });
    const c2 = await saveCampaign(user.id, other.id, { name: "Andere", note: "", followups: [] });
    const ok = await lead(t.id), noLi = await lead(t.id, { linkedin: "" }), mailed = await lead(t.id, { status: "angeschrieben" });
    const noHook = await lead(t.id), dup = await lead(t.id, { linkedin: ok.linkedin.toUpperCase() }), contact = await lead(t.id, { status: "kontakt" });
    /* the same person as a lead in the other tenant, already handed to SendPilot there */
    const sp = await lead(t.id), spOther = await lead(other.id, { linkedin: sp.linkedin, sendpilotAt: new Date() });
    await db.insert(messages).values({ tenantId: t.id, leadId: ok.id, batchDate: "2026-11-18", variant: "A", status: "entwurf", subject: "s", body: "b" });

    const ids = [ok.id, noLi.id, mailed.id, dup.id, contact.id, sp.id, 999999999];
    const pre = await enroll(user.id, c1.id, ids, { confirm: false });
    expect(pre).toMatchObject({ confirmed: false, wouldAdd: 1 });
    const why = Object.fromEntries((pre.skipped as { leadId: number; reason: string }[]).map(s => [s.leadId, s.reason]));
    expect(why[noLi.id]).toMatch(/kein LinkedIn/);
    expect(why[mailed.id]).toMatch(/per Mail angeschrieben/);
    expect(why[dup.id]).toMatch(/doppelt/);
    expect(why[contact.id]).toMatch(/Kontakt/);
    expect(why[sp.id]).toMatch(/schon über LinkedIn/);
    expect(why[999999999]).toMatch(/nicht in diesem Mandanten/);
    expect(await enr(ok.id)).toBeUndefined();

    const done = await enroll(user.id, c1.id, ids, { confirm: true });
    expect(done).toMatchObject({ confirmed: true, added: 1 });
    /* out of the mail run, its draft gone */
    const [okNow] = await db.select().from(leads).where(eq(leads.id, ok.id));
    expect(okNow.sendpilotAt).not.toBeNull();
    expect(await db.select().from(messages).where(eq(messages.leadId, ok.id))).toHaveLength(0);

    /* mailed ones only with allowMailed */
    expect(await enroll(user.id, c1.id, [mailed.id], { confirm: true, allowMailed: true })).toMatchObject({ added: 1 });

    /* the same profile from another tenant's lead: refused */
    const again = await lead(other.id, { linkedin: ok.linkedin });
    const r = await enroll(user.id, c2.id, [again.id, spOther.id], { confirm: true });
    expect(r).toMatchObject({ added: 0 });
    expect((r.skipped as { reason: string }[]).map(s => s.reason).join("|")).toMatch(/schon in Kampagne/);

    /* a placeholder without value skips the person */
    const c3 = await saveCampaign(user.id, t.id, { name: "Aufhänger", note: "Zu {{aufhaenger}}", followups: [] });
    expect(((await enroll(user.id, c3.id, [noHook.id], { confirm: false })).skipped as { reason: string }[])[0].reason).toMatch(/aufhaenger/);
    await setCampaignStatus(user.id, c1.id, "beendet");
    await setCampaignStatus(user.id, c3.id, "beendet");
  });

  it("sendet nur in der Sendezeit, eine Aktion zugleich, und nie einen Schritt zweimal", async () => {
    const c = await saveCampaign(user.id, t.id, { name: "Mit Folgen", note: "Hallo {{vorname}}", followups: [{ afterDays: 3, text: "Danke fürs Vernetzen, {{vorname}}." }, { afterDays: 4, text: "Kurz nachgehakt." }] });
    const a = await lead(t.id, { first: "Anna" }), b = await lead(t.id, { first: "Ben" });
    await enroll(user.id, c.id, [a.id, b.id], { confirm: true });

    /* campaign still a draft: nothing to send */
    expect(await claim(await sender(sid), tick())).toMatchObject({ wait: 600 });
    await setCampaignStatus(user.id, c.id, "aktiv");
    expect(await claim(await sender(sid), new Date("2026-11-21T10:00:00Z"))).toMatchObject({ reason: "außerhalb der Sendezeit" });

    const x = action(await claim(await sender(sid), tick()));
    expect(x).toMatchObject({ kind: "anfrage", text: "Hallo Anna", withNote: true, handle: (await enr(a.id)).handle });
    expect(await claim(await sender(sid), tick(1))).toMatchObject({ reason: `Aktion ${x.id} läuft noch` });
    await report(await sender(sid), x.id, { outcome: "gesendet" }, tick(1));
    expect(await enr(a.id)).toMatchObject({ state: "angefragt", step: 1 });
    expect((await db.select().from(leads).where(eq(leads.id, a.id)))[0].status).toBe("angeschrieben");
    /* a late second report changes nothing */
    expect(await report(await sender(sid), x.id, { outcome: "fehler" }, tick(1))).toMatchObject({ ignored: expect.any(String) });
    /* pause between actions */
    expect(await claim(await sender(sid), new Date(clock + 30_000))).toMatchObject({ reason: "Pause zwischen Aktionen" });

    /* Ben's invite goes out, no answer comes back: never handed out again, a check settles it */
    const y = action(await claim(await sender(sid), tick()));
    expect(y).toMatchObject({ kind: "anfrage", text: "Hallo Ben" });
    expect(await claim(await sender(sid), tick(STALE_MIN + 1))).toMatchObject({ reason: "Pause zwischen Aktionen" });
    const z = action(await claim(await sender(sid), tick()));
    expect(z).toMatchObject({ kind: "pruefen", settle: { kind: "anfrage", text: "Hallo Ben" } });
    expect((await db.select().from(liActions).where(eq(liActions.id, y.id)))[0].status).toBe("unklar");
    await report(await sender(sid), z.id, { outcome: "ok", pending: true }, tick(1));
    expect(await enr(b.id)).toMatchObject({ state: "angefragt", step: 1 });
    expect((await db.select().from(liActions).where(eq(liActions.id, y.id)))[0].status).toBe("erledigt");

    /* Anna accepted: check the next day, first message 3 days later */
    clock = Date.parse("2026-11-19T10:00:00Z");
    const chk = action(await claim(await sender(sid), tick()));
    expect(chk).toMatchObject({ kind: "pruefen", handle: (await enr(a.id)).handle });
    await report(await sender(sid), chk.id, { outcome: "ok", connected: true }, tick(1));
    expect(await enr(a.id)).toMatchObject({ state: "vernetzt", step: 1 });
    /* the message waits its 3 days */
    expect(await claim(await sender(sid), tick())).toMatchObject({ wait: 600 });

    clock = Date.parse("2026-11-23T09:00:00Z");
    const m = action(await claim(await sender(sid), tick()));
    expect(m).toMatchObject({ kind: "nachricht", text: "Danke fürs Vernetzen, Anna." });
    await report(await sender(sid), m.id, { outcome: "gesendet" }, tick(1));
    expect(await enr(a.id)).toMatchObject({ state: "vernetzt", step: 2 });

    /* before the second message the worker sees a reply: nothing sent, the sequence stops, the lead counts as answered */
    clock = Date.parse("2026-11-27T12:00:00Z");
    let m2 = action(await claim(await sender(sid), tick()));
    while (m2.kind === "pruefen") { await report(await sender(sid), m2.id, { outcome: "ok", pending: true }, tick(1)); m2 = action(await claim(await sender(sid), tick())); }
    expect(m2).toMatchObject({ kind: "nachricht", text: "Kurz nachgehakt." });
    await report(await sender(sid), m2.id, { outcome: "beantwortet", reply: "Gern, rufen Sie an." }, tick(1));
    expect(await enr(a.id)).toMatchObject({ state: "beantwortet", reply: "Gern, rufen Sie an." });
    expect((await db.select().from(leads).where(eq(leads.id, a.id)))[0].status).toBe("beantwortet");
    const hist = (await listPeople(user.id, { campaignId: c.id, limit: 10, offset: 0 })).find(p => p.leadId === a.id)!;
    expect(hist.history.filter(h => h.kind === "nachricht" && h.status === "erledigt")).toHaveLength(1);
    await setCampaignStatus(user.id, c.id, "beendet");
  });

  it("hält Kampagnen mit Notiz an, wenn LinkedIn keine Notizen mehr erlaubt, und hält das Tageslimit", async () => {
    clock = Date.parse("2026-12-02T09:00:00Z");
    await db.update(liEnrollments).set({ state: "fertig" }).where(eq(liEnrollments.senderId, sid));
    const pause = await saveCampaign(user.id, t.id, { name: "Notiz, pausieren", note: "Hallo {{vorname}}", followups: [] });
    const p1 = await lead(t.id), p2 = await lead(t.id);
    await enroll(user.id, pause.id, [p1.id, p2.id], { confirm: true });
    await setCampaignStatus(user.id, pause.id, "aktiv");
    const a1 = action(await claim(await sender(sid), tick()));
    await report(await sender(sid), a1.id, { outcome: "notizlimit" }, tick(1));
    expect((await sender(sid)).noteBlockedUntil?.toISOString()).toBe("2027-01-01T06:00:00.000Z");
    expect(await enr(a1.handle === (await enr(p1.id)).handle ? p1.id : p2.id)).toMatchObject({ state: "wartet", step: 0 });
    expect(await claim(await sender(sid), tick())).toMatchObject({ reason: expect.stringMatching(/keine Notizen/) });

    const without = await saveCampaign(user.id, t.id, { name: "Notiz, sonst ohne", note: "Hallo {{vorname}}", followups: [], noteFallback: "ohne_notiz" });
    const q = await lead(t.id);
    await enroll(user.id, without.id, [q.id], { confirm: true });
    await setCampaignStatus(user.id, without.id, "aktiv");
    const a2 = action(await claim(await sender(sid), tick()));
    expect(a2).toMatchObject({ kind: "anfrage", withNote: false, text: "" });
    await report(await sender(sid), a2.id, { outcome: "gesendet_ohne_notiz" }, tick(1));

    /* daily limit: today's invites already count */
    await db.update(liSenders).set({ noteBlockedUntil: null, limits: { gapMin: 5, gapMax: 6, invites: 1 } }).where(eq(liSenders.id, sid));
    expect(await claim(await sender(sid), tick())).toMatchObject({ reason: expect.stringMatching(/Tageslimit/) });
    await setCampaignStatus(user.id, pause.id, "beendet");
    await setCampaignStatus(user.id, without.id, "beendet");
  });

  it("ist über MCP erreichbar und verlangt für die Aufnahme ein confirm", async () => {
    const client = await mcp((await connectorTokens(user)).access_token);
    const names = (await client.listTools()).tools.map(x => x.name);
    expect(names).toEqual(expect.arrayContaining(["linkedin_status", "linkedin_campaign_save", "linkedin_enroll", "linkedin_people", "linkedin_stop", "linkedin_campaign_status", "linkedin_settings"]));
    const c = await client.tool<{ id: number; status: string }>("linkedin_campaign_save", { tenant: t.slug, name: "MCP", note: "Hallo {{vorname}}" });
    expect(c.status).toBe("entwurf");
    const l = await lead(t.id);
    expect(await client.tool("linkedin_enroll", { campaignId: c.id, leadIds: [l.id] })).toMatchObject({ confirmed: false, wouldAdd: 1 });
    expect(await enr(l.id)).toBeUndefined();
    const s = await client.tool<{ worker: { online: boolean } }>("linkedin_status");
    expect(s.worker).toHaveProperty("online");
    await client.close();
  });
});
