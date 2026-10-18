import { describe, expect, it } from "vitest";
import { fitOf } from "@/lib/lead-fit";
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
    expect(tender.reasons.map(r => r.text)).toContain("Ausschreibung, 2 Tage alt");
  });

  it("Noten: bester Fall A, info@ ohne Namen, Rolle und Anlass D", () => {
    expect(rate({ fit: 4, tenders: [{ t: "Kanal", s: "Stadt", f: "" }], createdAt: ago(0) }).grade).toBe("A");
    expect(rate({ email: "info@x.de", emailType: "info", first: "", last: "", salutation: "", role: "", fit: 2 }).grade).toBe("D");
  });

  it("ohne Mail: nur LinkedIn niedriger, gar kein Weg noch niedriger, aber die Passung bleibt sichtbar", () => {
    const li = rate({ email: "", linkedin: "https://linkedin.com/in/k" }), none = rate({ email: "" });
    expect(rate({}).rating!).toBeGreaterThan(li.rating!);
    expect(li.rating!).toBeGreaterThan(none.rating!);
    expect(none.rating!).toBeGreaterThan(10);
  });

  it("Ausschluss der KI oder Passung 0 ergibt 0, auch mit Daumen und Ausschreibung", () => {
    const ko = { company: 0, person: 0, need: 0, evidence: 0, segment: "", ko: "Testeintrag, keine echte Firma", why: "", model: "m", hash: "h", at: "" };
    const r = rate({ email: "", first: "", last: "", role: "", fit: 0, fitInfo: ko, vote: 1, tenders: [{ t: "Kanal", s: "Stadt", f: "30.11." }] });
    expect(r.rating).toBe(0);
    expect(r.grade).toBe("D");
    expect(r.reasons[0].text).toBe("Testeintrag, keine echte Firma");
  });

  it("noch nicht von der KI bewertet: keine Zahl", () => {
    expect(rate({ fit: null }).rating).toBeNull();
  });

  it("Daumen hoch hebt, Daumen runter halbiert, Überspringen senkt leicht", () => {
    const r0 = rate({}).rating!;
    expect(rate({ vote: 1 }).rating! - r0).toBeGreaterThanOrEqual(8);
    expect(rate({ vote: 1 }).rating! - r0).toBeLessThanOrEqual(16);
    expect(rate({ vote: -1 }).rating!).toBeLessThanOrEqual(Math.ceil(r0 / 2));
    expect(rate({ skips: 1 }).rating!).toBeLessThan(r0);
  });

  it("Streuung: verschiedene Teilurteile der KI ergeben verschiedene Werte", () => {
    const seen = new Set<number>();
    for (const company of [0, 1, 2, 3, 4]) for (const person of [0, 1, 2, 3, 4]) for (const need of [0, 2, 4]) for (const email of ["k.albers@albers-bau.de", "info@albers-bau.de"]) {
      const fit = fitOf({ company, person, need, evidence: 2 }, "");
      seen.add(rate({ fit, email, emailType: email.startsWith("info") ? "info" : "person" }).rating!);
    }
    expect(seen.size).toBeGreaterThanOrEqual(45);
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
