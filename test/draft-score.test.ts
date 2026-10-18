import { describe, expect, it } from "vitest";
import { calibrate, draftScore, expectedRate } from "@/lib/draft-score";

const jev = { reply: 3, specific: 1, easyAsk: 1 };
const short = { subject: "Kanalbau Bielefeld", body: "Guten Tag Frau Albers,\n\nIhre Firma baut gerade den Regenwasserkanal in Bielefeld. Wir finden passende Ausschreibungen im Umkreis, bevor sie in den Portalen auffallen.\n\nDarf ich Ihnen drei aktuelle schicken?\n\nViele Grüße\nNiklas Fink", hook: true };
const words = (n: number) => Array.from({ length: n }, (_, i) => `wort${i}`).join(" ");

describe("Anschreiben-Score", () => {
  it("kurze, konkrete Mail mit einer Bitte: Jev-Wert ohne Abzug", () => {
    expect(draftScore(jev, short)).toEqual({ score: 83, issues: [] });
  });

  it("Regeln aus 6.337 Kaltmails ziehen ab und werden benannt", () => {
    const r = draftScore(jev, { subject: "Ein sehr langer Betreff mit vielen Wörtern", body: `${words(128)} https://x.de ?`, hook: true });
    expect(r.issues).toEqual(["128 Wörter", "Betreff 42 Zeichen", "Link im Text"]);
    expect(r.score).toBe(83 - 25 - 10 - 15);
  });

  it("80 bis 100 Wörter kosten wenig, mehrere Fragen und fehlender Anlass mehr", () => {
    const r = draftScore(jev, { subject: "Kurz", body: `${words(90)} Passt das? Oder lieber später?`, hook: false });
    expect(r.issues).toEqual(["95 Wörter", "2 Fragen", "Kein Anlass"]);
    expect(r.score).toBe(83 - 5 - 5 - 10);
  });

  it("Jev: unkonkret und ohne klare Bitte", () => {
    expect(draftScore({ reply: 1, specific: 0.2, easyAsk: 0.1 }, short)).toEqual({ score: Math.round(70 * 0.25 + 15 * 0.2 + 15 * 0.1), issues: ["Nichts Konkretes zur Firma", "Keine klare Bitte"] });
  });

  it("nie unter 0", () => {
    expect(draftScore({ reply: 0, specific: 0, easyAsk: 0 }, { subject: words(10), body: `${words(300)} http://a.b`, hook: false }).score).toBe(0);
  });
});

describe("Kalibrierung an echten Antworten", () => {
  const sent = (score: number, n: number, replies: number) => Array.from({ length: n }, (_, i) => ({ score, replied: i < replies }));

  it("zu wenig Daten: keine erwartete Quote", () => {
    expect(calibrate(sent(80, 29, 5))).toBeNull();
    expect(calibrate(sent(80, 40, 2))).toBeNull();
  });

  it("erwartete Quote je Score-Bereich, zur Gesamtquote hin geglättet", () => {
    const cal = calibrate([...sent(85, 20, 6), ...sent(30, 20, 0)])!;
    /* gesamt 6/40 = 15 %; oben (6 + 10·0,15) / (20 + 10) = 25 %, unten (0 + 1,5) / 30 = 5 % */
    expect(cal(90)).toBeCloseTo(0.25, 5);
    expect(cal(20)).toBeCloseTo(0.05, 5);
    /* Bereich ohne Daten: Gesamtquote */
    expect(cal(65)).toBeCloseTo(0.15, 5);
    expect(draftScore(jev, short, cal)).toEqual({ score: 83, issues: [], expected: 0.25 });
  });
});

describe("Vorlagen: erwartete Antwortquote", () => {
  it("ohne Sendungen der Prior, mit vielen Sendungen die echte Quote", () => {
    expect(expectedRate(0, 0, 0.05)).toBeCloseTo(0.05, 5);
    /* (3 + 20·0,05) / (20 + 20) = 10 % */
    expect(expectedRate(20, 3, 0.05)).toBeCloseTo(0.1, 5);
    expect(expectedRate(2000, 200, 0.05)).toBeCloseTo(0.0995, 3);
  });
});
