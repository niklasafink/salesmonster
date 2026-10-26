import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, leads, messages, tenants, users } from "@/db";
import { DELETE, GET, POST } from "@/app/api/suppressions/route";
import { addLeads } from "@/lib/lead-import";
import { mailQueue } from "@/lib/queue";
import { sendApproved, setLeadStatus } from "@/lib/outreach";
import { blockedAddresses, blockedOf, blockedWhy, parseEntry } from "@/lib/suppress";
import { fileContacts } from "@/lib/crm-sync";
import { call, fixtures } from "./helpers";

const fx = fixtures();
let me: typeof users.$inferSelect, t: typeof tenants.$inferSelect;

beforeAll(async () => { me = await fx.user(); t = await fx.tenant(me); });
afterAll(() => fx.cleanup());

describe("Sperrliste", () => {
  it("erkennt Adresse, Domain und LinkedIn-Profil; Freemail nur als Adresse", () => {
    expect(parseEntry(" Max@Firma.de ")).toEqual({ kind: "email", value: "max@firma.de" });
    expect(parseEntry("https://www.wettbewerber.de/kontakt")).toEqual({ kind: "domain", value: "wettbewerber.de" });
    expect(parseEntry("@wettbewerber.de")).toEqual({ kind: "domain", value: "wettbewerber.de" });
    expect(parseEntry("https://www.linkedin.com/in/Jana-Lindner/?x=1")).toEqual({ kind: "linkedin", value: "jana-lindner" });
    expect(parseEntry("gmail.com")).toBeNull();
    expect(parseEntry("kein eintrag")).toBeNull();
  });

  it("legt per Route an, meldet Unerkanntes, sucht und löscht nur im eigenen Mandanten", async () => {
    const r = await call(POST, { as: me, body: { t: t.slug, entries: "max@firma.de\nwettbewerber.de\nquatsch\nlinkedin.com/in/jana" } });
    expect(r.json).toEqual({ added: 3, invalid: ["quatsch"] });
    expect((await call(POST, { as: me, body: { t: t.slug, entries: "MAX@firma.de" } })).json.added).toBe(0);
    const list = await call(GET, { as: me, path: `/api/suppressions?t=${t.slug}&q=wett` });
    expect(list.json.total).toBe(1);
    const other = await fx.user();
    expect((await call(DELETE, { as: other, method: "DELETE", path: `/api/suppressions?t=${t.slug}&id=${list.json.rows[0].id}` })).status).toBe(404);
  });

  it("gilt für Adresse, Domain der Adresse oder Website und LinkedIn", async () => {
    const b = await blockedOf(t.id);
    expect(blockedWhy(b, { email: "Max@firma.de" })).toBe("Adresse gesperrt");
    expect(blockedWhy(b, { email: "info@wettbewerber.de" })).toBe("Domain gesperrt");
    expect(blockedWhy(b, { website: "https://wettbewerber.de" })).toBe("Domain gesperrt");
    expect(blockedWhy(b, { linkedin: "https://linkedin.com/in/Jana" })).toBe("LinkedIn gesperrt");
    expect(blockedWhy(b, { email: "ok@firma.de" })).toBe("");
    expect(await blockedAddresses(t.id, ["ok@firma.de", "a@wettbewerber.de"])).toEqual(["a@wettbewerber.de"]);
  });

  it("Gesperrte kommen nicht in die Warteschlange und werden beim Import übersprungen", async () => {
    const [l] = await db.insert(leads).values({ tenantId: t.id, company: "Wettbewerber GmbH", email: "chef@wettbewerber.de", status: "neu" }).returning();
    expect((await mailQueue(t)).map(q => q.id)).not.toContain(l.id);
    const r = await addLeads(t.id, [{ co: "Firma AG", p: "Max Muster", role: "", email: "max@firma.de", web: "", city: "" }], "Test");
    expect(r.skipped).toEqual([{ company: "Firma AG", why: "Sperrliste: Adresse gesperrt" }]);
  });

  it("eine freigegebene Mail an eine inzwischen gesperrte Adresse geht nicht raus", async () => {
    const [l] = await db.insert(leads).values({ tenantId: t.id, company: "Firma", email: "max@firma.de", status: "freigabe" }).returning();
    const [m] = await db.insert(messages).values({ tenantId: t.id, leadId: l.id, leadIds: [l.id], to: "max@firma.de", batchDate: "2026-10-25", variant: "A", subject: "x", body: "y", finalSubject: "x", finalBody: "y", status: "freigegeben", senderId: me.id }).returning();
    await sendApproved(t, { now: true });
    const [after] = await db.select().from(messages).where(eq(messages.id, m.id));
    expect(after.status).toBe("gesperrt");
    expect(after.error).toContain("Gesperrt");
    expect(after.sentAt).toBeNull();
  });

  it("unzustellbar und Opt-out in HubSpot landen von selbst auf der Liste", async () => {
    const [l] = await db.insert(leads).values({ tenantId: t.id, company: "Weg GmbH", email: "weg@weg-gmbh.de", status: "angeschrieben" }).returning();
    await setLeadStatus(t.id, l.id, "unzustellbar");
    await fileContacts(t.id, "signup_datum", [{ id: "8801", properties: { email: "raus@kunde.de", hs_email_optout: "true", createdate: "2026-10-01T00:00:00Z" } }], null);
    const b = await blockedOf(t.id);
    expect(b.email.has("weg@weg-gmbh.de") && b.email.has("raus@kunde.de")).toBe(true);
  });
});
