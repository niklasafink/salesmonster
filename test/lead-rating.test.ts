import { describe, expect, it } from "vitest";
import { learnModel, rateLead, type RateLead } from "@/lib/lead-rating";

const NOW = new Date("2026-10-18T12:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * 864e5);
const base: RateLead = { status: "neu", email: "k.albers@albers-bau.de", emailType: "person", first: "Katrin", last: "Albers", salutation: "Frau", role: "Geschäftsführerin",
  linkedin: "", hook: "", tenders: [], fit: 3, vote: 0, skips: 0, source: "Claude-Recherche", angleId: null, createdAt: ago(1) };
const empty = learnModel([]);
const rate = (p: Partial<RateLead>, model = empty) => rateLead({ ...base, ...p }, model, NOW);

describe("Lead-Bewertung", () => {
  it("Top-Firma mit info@ ist deutlich schlechter als dieselbe Firma mit persönlicher Adresse der Geschäftsführung", () => {
    const personal = rate({}), info = rate({ email: "info@albers-bau.de", emailType: "info", first: "", last: "", salutation: "", role: "" });
    expect(personal.rating! - info.rating!).toBeGreaterThanOrEqual(20);
    expect(info.reasons.map(r => r.text)).toContain("Sammeladresse");
    expect(info.reasons.find(r => r.text === "Sammeladresse")!.pts).toBeLessThan(0);
  });

  it("info@ wird auch erkannt, wenn die Recherche person angegeben hat", () => {
    expect(rate({ email: "kontakt@albers-bau.de" }).reasons.map(r => r.text)).toContain("Sammeladresse");
  });

  it("frische Ausschreibung zählt mehr als ein alter Anlass, abgelaufene Frist nicht", () => {
    const tender = rate({ tenders: [{ t: "Kanal", s: "Stadt", f: "30.11." }], createdAt: ago(2) });
    const oldHook = rate({ hook: "die neue Halle", createdAt: ago(90) });
    const expired = rate({ tenders: [{ t: "Kanal", s: "Stadt", f: "01.10." }], createdAt: ago(2) });
    expect(tender.rating!).toBeGreaterThan(oldHook.rating!);
    expect(oldHook.rating!).toBeGreaterThan(rate({}).rating! - 1);
    expect(expired.rating).toBe(rate({}).rating);
    expect(tender.reasons[0].text).toBe("Ausschreibung, 2 Tage alt");
  });

  it("Noten: bester Fall A, info@ ohne Namen, Rolle und Anlass D", () => {
    expect(rate({ fit: 4, tenders: [{ t: "Kanal", s: "Stadt", f: "" }], createdAt: ago(0) }).grade).toBe("A");
    expect(rate({ email: "info@x.de", emailType: "info", first: "", last: "", salutation: "", role: "", fit: 2 }).grade).toBe("D");
  });

  it("nur LinkedIn: niedrig, aber nicht null; gar kein Weg: null", () => {
    const li = rate({ email: "", linkedin: "https://linkedin.com/in/k" }), none = rate({ email: "" });
    expect(li.rating!).toBeGreaterThan(20);
    expect(none.rating).toBe(0);
    expect(rate({ email: "", first: "", last: "", role: "", fit: null, vote: 1, tenders: [{ t: "Kanal", s: "Stadt", f: "30.11." }] }).rating).toBe(0);
  });

  it("Daumen hoch etwa +6, Daumen runter etwa −17, Überspringen leicht negativ", () => {
    const r0 = rate({}).rating!;
    expect(rate({ vote: 1 }).rating! - r0).toBeGreaterThanOrEqual(5);
    expect(rate({ vote: 1 }).rating! - r0).toBeLessThanOrEqual(6);
    expect(r0 - rate({ vote: -1 }).rating!).toBeGreaterThanOrEqual(16);
    expect(r0 - rate({ vote: -1 }).rating!).toBeLessThanOrEqual(18);
    expect(rate({ skips: 1 }).rating!).toBeLessThan(r0);
  });

  it("unzustellbar, Papierkorb, Dublette und Postfach-Kontakte bekommen keine Bewertung", () => {
    for (const status of ["unzustellbar", "papierkorb", "dublette", "kontakt"]) expect(rate({ status }).rating).toBeNull();
  });
});

describe("Lernen aus Ergebnissen", () => {
  const sent = (n: number, replies: number, p: Partial<RateLead>) => Array.from({ length: n }, (_, i) => ({ lead: { ...base, ...p }, delivered: true, replied: i < replies }));

  it("wenige Daten: kaum Einfluss", () => {
    const m = learnModel([...sent(5, 1, { angleId: 7 }), ...sent(5, 0, { angleId: 8 })]);
    expect(Math.abs(rate({ angleId: 7 }, m).rating! - rate({ angleId: 8 }, m).rating!)).toBeLessThanOrEqual(6);
  });

  it("viele Daten: die Suchrichtung mit Antworten zieht ihre Leads nach oben und gilt als gelernt", () => {
    const m = learnModel([...sent(200, 40, { angleId: 7 }), ...sent(200, 2, { angleId: 8 })]);
    const a = rate({ angleId: 7 }, m), b = rate({ angleId: 8 }, m);
    expect(a.rating! - b.rating!).toBeGreaterThanOrEqual(15);
    expect(a.reasons.find(r => r.learned)?.text).toBe("Suchrichtung antwortet gut");
  });

  it("echte Daten können den Startwert für info@ überstimmen", () => {
    const m = learnModel([...sent(300, 45, { email: "info@a.de", emailType: "info" }), ...sent(300, 9, {})]);
    expect(rate({ email: "info@b.de", emailType: "info" }, m).rating!).toBeGreaterThan(rate({}, m).rating!);
  });

  it("Daumen zählen als halbe Beobachtung für ähnliche Leads", () => {
    const votes = Array.from({ length: 80 }, () => ({ lead: { ...base, angleId: 9, vote: 1 }, delivered: false, replied: false }));
    const m = learnModel(votes);
    expect(rate({ angleId: 9 }, m).rating!).toBeGreaterThan(rate({ angleId: 10 }, m).rating!);
  });

  it("frühere Bounces einer Domain senken die Zustellbarkeit", () => {
    const m = learnModel([{ lead: { ...base, email: "a@kaputt.de" }, delivered: false, replied: false, bounced: true }]);
    expect(rate({ email: "b@kaputt.de" }, m).rating!).toBeLessThan(rate({}, m).rating!);
  });
});
