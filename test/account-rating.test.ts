import { describe, expect, it } from "vitest";
import type { CompanyProfile } from "@/db/schema";
import { rateAccount, type AccountLead } from "@/lib/account-rating";
import { cleanJudged, viewOf } from "@/lib/company-profile";
import { learnModel, rateLead, type RateLead } from "@/lib/lead-rating";
import { RUBRICS, rubricOf } from "@/lib/rubrics";
import { activityText, notesOf, plain, type Act } from "@/lib/touches";

const NOW = new Date("2026-10-27T12:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * 864e5);
const VH = RUBRICS.vergabehero, CHETTI = RUBRICS.chetti, CONFORMIS = RUBRICS.conformis;
const prof = (p: Partial<CompanyProfile>): CompanyProfile => ({ type: "bieter", size: "s50", fit: "kern", signals: [], employees: null, why: "", sure: 0.9, web: false, sources: [], model: "m", hash: "h", at: "", ...p });
const person = (p: Partial<AccountLead> = {}): AccountLead => ({ email: "m.muster@firma.de", emailType: "person", role: "", stage: "lead", crmAt: ago(40), vote: 0, inbound: true, colleagues: 0, ...p });
const vh = (p: Partial<CompanyProfile>, l: Partial<AccountLead> = {}) => rateAccount(prof(p), person(l), VH, NOW);

describe("Firmenbewertung VergabeHero (Test vom 27.10.2026)", () => {
  const hochtief = vh({ size: "s10000", employees: 40000 }, { email: "marc.froese@hochtief.de", crmAt: ago(1) });
  const drees = vh({ size: "s1000" }, { email: "jan.barth@dreso.com", colleagues: 1 });
  const siekmann = vh({ size: "s50" }, { email: "vergabe@siekmann-ingenieure.de", emailType: "info", stage: "opportunity", colleagues: 1, crmAt: ago(8) });
  const kapellmann = vh({ type: "multiplikator", size: "s250" }, { email: "christoph.carstens@kapellmann.de" });
  const bahn = vh({ type: "sektor", size: "s10000", fit: "unklar" }, { email: "lukas-paul.schoen@deutschebahn.com" });
  const koblenz = vh({ type: "auftraggeber", size: "s1000", fit: "unklar" }, { email: "dagmar.koerner@stadt.koblenz.de" });
  const schmidt = vh({ size: "s1" }, { email: "peter-schmidt@gmx.net" });

  it("ergibt die abgenommenen Werte und Noten, ein idealer Konzern fast 100", () => {
    expect([hochtief.rating, drees.rating, siekmann.rating, kapellmann.rating, bahn.rating, koblenz.rating, schmidt.rating]).toEqual([97, 95, 89, 65, 60, 25, 26]);
    expect([hochtief.grade, kapellmann.grade, koblenz.grade, schmidt.grade]).toEqual(["A", "B", "D", "D"]);
  });

  it("ein Vergabe-Postfach ist bei einer Registrierung ein Plus, kein Abzug", () => {
    expect(siekmann.reasons.find(r => r.text === "Postfach für Vergabe und Angebote")?.pts).toBe(15);
    expect(vh({}, { email: "info@firma.de", emailType: "info" }).reasons.some(r => r.pts < 0)).toBe(false);
  });

  it("Signale sind auf +25 gedeckelt, der Firmentyp deckelt die Summe und sagt warum", () => {
    expect(siekmann.parts.reach).toBe(25);
    expect(koblenz.reasons.map(r => r.text)).toContain("Höchstens 25: Öffentlicher Auftraggeber");
    expect(vh({ size: "s10000" }, { stage: "opportunity", crmAt: ago(1) }).rating).toBe(100);
  });

  it("Wettbewerber, Testeinträge und Bestandskunden bekommen keine Bewertung", () => {
    expect(vh({ type: "wettbewerber" }).rating).toBeNull();
    expect(vh({ type: "test" }).rating).toBeNull();
    expect(vh({}, { stage: "customer" }).rating).toBeNull();
  });

  it("Notizen aus Gesprächen wirken: Absage senkt, Interesse hebt", () => {
    expect(vh({ signals: ["absage"] }).rating!).toBeLessThan(vh({}).rating! - 10);
    expect(vh({ signals: ["interesse"] }).rating!).toBeGreaterThan(vh({}).rating!);
  });

  it("ohne Firmenprofil vorläufig in der Mitte, die Person sortiert trotzdem", () => {
    const a = rateAccount(null, person({ stage: "opportunity" }), VH, NOW), b = rateAccount(null, person({ email: "x@gmail.com" }), VH, NOW);
    expect(a.reasons.map(r => r.text)).toContain("Vorläufig, Firma noch nicht geprüft");
    expect(a.rating!).toBeGreaterThan(b.rating!);
  });

  it("Daumen wirkt sofort", () => {
    expect(vh({}, { vote: 1 }).rating!).toBeGreaterThan(vh({}).rating!);
    expect(vh({}, { vote: -1 }).rating!).toBeLessThan(vh({}).rating!);
  });
});

describe("Chetti: inhabergeführt mit 2–6 Behandlern, MVZ nur mit Fokus auf Abläufe", () => {
  const ch = (p: Partial<CompanyProfile>) => rateAccount(prof({ type: "praxis", size: "b4", fit: "allgemein", ...p }), person({ inbound: false }), CHETTI, NOW).rating!;
  it("2–6 Behandler schlagen Einzelpraxis und große Gruppe", () => {
    expect(ch({ size: "b4" })).toBeGreaterThan(ch({ size: "b1" }));
    expect(ch({ size: "b2" })).toBeGreaterThan(ch({ size: "b16" }));
  });
  it("MVZ mit Fokus auf Abläufe ist gut, MVZ-Kette ohne gedeckelt", () => {
    expect(ch({ type: "mvz_effizient", size: "b7", fit: "chirurgie", signals: ["digital", "personal"] })).toBeGreaterThan(70);
    expect(ch({ type: "mvz", size: "b16", fit: "chirurgie", signals: ["digital", "personal", "jung"] })).toBeLessThanOrEqual(70);
  });
});

describe("Conformis: kleinere WPGs zuerst", () => {
  const co = (p: Partial<CompanyProfile>) => rateAccount(prof({ type: "wpg", fit: "fs", ...p }), person({ inbound: false }), CONFORMIS, NOW).rating!;
  it("kleine WPG vor mittlerer, großer und Big Four", () => {
    expect(co({ size: "wpg_klein" })).toBeGreaterThan(co({ size: "wpg_mittel" }));
    expect(co({ size: "wpg_mittel" })).toBeGreaterThan(co({ size: "wpg_gross" }));
    expect(co({ type: "bigfour", size: "wpg_gross" })).toBeLessThanOrEqual(35);
  });
});

describe("Kalt-Leads mit Bewertungsprofil", () => {
  const base: RateLead = { status: "neu", email: "k.albers@albers.de", emailType: "person", first: "Katrin", last: "Albers", salutation: "Frau", role: "Inhaberin",
    linkedin: "", hook: "", tenders: [], fit: null, vote: 0, skips: 0, source: "Claude-Recherche", angleId: null, createdAt: ago(1) };
  const m = learnModel([]);
  it("starten bei der Firmenbewertung, Sammeladresse und Anlass wirken weiter", () => {
    const a = { score: 80, reasons: [], why: "Praxis mit 4 Behandlern" };
    const personal = rateLead({ ...base, account: a }, m, NOW), info = rateLead({ ...base, account: a, email: "info@albers.de", emailType: "info" }, m, NOW);
    expect(personal.reasons[0]).toEqual({ pts: 80, text: "Praxis mit 4 Behandlern" });
    expect(personal.rating!).toBeGreaterThanOrEqual(80);
    expect(info.rating!).toBeLessThan(personal.rating! - 20);
    expect(rateLead({ ...base, account: { ...a, score: 30 } }, m, NOW).rating!).toBeLessThan(personal.rating!);
  });
});

describe("Bewertungsprofil je Mandant", () => {
  it("nach Slug, Einstellung geht vor, sonst keins", () => {
    expect(rubricOf({ slug: "vh", settings: {} })?.key).toBe("vergabehero");
    expect(rubricOf({ slug: "conformis-grc", settings: {} })?.key).toBe("conformis");
    expect(rubricOf({ slug: "vh", settings: { rubric: "chetti" } })?.key).toBe("chetti");
    expect(rubricOf({ slug: "qa-testfirma", settings: {} })).toBeNull();
  });
  it("unbekannte Schlüssel des Modells werden zu unklar", () => {
    const j = cleanJudged(VH, { id: 3, type: "konzern", size: "riesig", fit: "kern", signals: ["absage", "erfunden"], employees: -4, why: "x", sure: 3 });
    expect(j).toMatchObject({ type: "unklar", size: "s1", fit: "kern", signals: ["absage"], employees: null, sure: 1 });
  });
  it("das Modell sieht Domain, Postfach-Namen und Notizen, nie ganze Adressen", () => {
    const v = viewOf({ id: 1, name: "Siekmann", domain: "", profile: null }, [
      { companyId: 1, company: "Siekmann", email: "vergabe@siekmann-ingenieure.de", website: "", city: "", role: "", hook: "", note: "", research: "", touch: { notes: "Ingenieurbüro, 80 Leute" } },
      { companyId: 1, company: "Siekmann", email: "k.jakob@siekmann-ingenieure.de", website: "", city: "", role: "", hook: "", note: "", research: "", touch: null }]);
    expect(v).toMatchObject({ domain: "siekmann-ingenieure.de", adressen: "vergabe, k.jakob", personen: 2, notizen: "Ingenieurbüro, 80 Leute" });
    expect(viewOf({ id: 2, name: "x", domain: "", profile: null }, [{ companyId: 2, company: "x", email: "a@gmx.de", website: "", city: "", role: "", hook: "", note: "", research: "", touch: null }]).domain).toBe("keine, nur Freemail");
  });
});

describe("Kontakt aus HubSpot-Aktivitäten", () => {
  const acts: Act[] = [
    { kind: "meetings", at: Date.parse("2026-11-05T12:00:00Z"), title: "Demo VergabeHero", body: "<p>Hallo</p>________________ Microsoft Teams meeting Join: https://x", extra: "" },
    { kind: "calls", at: Date.parse("2026-10-26T13:51:00Z"), title: "Telefonat mit Marc", body: "Sehr netter Typ, will erst testen", extra: "QUEUED" },
    { kind: "emails", at: Date.parse("2026-10-20T10:00:00Z"), title: "Re: Testphase", body: "Danke!", extra: "INCOMING_EMAIL" },
  ];
  it("neueste zuerst, Zukunft markiert, Teams-Block entfernt", () => {
    const t = activityText(acts, NOW).split("\n");
    expect(t[0]).toBe("- [Meeting, 5.11.2026, in der Zukunft] Demo VergabeHero: Hallo");
    expect(t[1]).toBe("- [Anruf, queued, 26.10.2026, vergangen] Telefonat mit Marc: Sehr netter Typ, will erst testen");
    expect(t[2]).toBe("- [E-Mail, eingehend, 20.10.2026, vergangen] Re: Testphase: Danke!");
  });
  it("Notizen für das Firmenprofil nur aus vergangenen Anrufen und Notizen", () => {
    expect(notesOf(acts, NOW)).toBe("Sehr netter Typ, will erst testen");
    expect(plain("a&amp;b&nbsp;<b>c</b>")).toBe("a&b c");
  });
});
