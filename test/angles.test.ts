import { describe, expect, it } from "vitest";
import { angleScore, pickAngles, rotation, roundsDue, startAngles, type AngleStat } from "@/lib/angles";

/* deterministic random numbers (mulberry32) */
const rng = (seed: number) => () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const a = (id: number, p: Partial<AngleStat> = {}): AngleStat => ({ id, origin: "ki", active: true, rounds: 3, sent: 0, replies: 0, prior: 0.04, ...p });

describe("Suchrichtungen", () => {
  it("Erfolg: Antworten auf einem Prior aus der mittleren Lead-Bewertung", () => {
    expect(angleScore(a(1, { prior: 0.05 }))).toBeCloseTo(0.05, 5);
    /* (6 + 20·0,05) / (40 + 20) */
    expect(angleScore(a(1, { prior: 0.05, sent: 40, replies: 6 }))).toBeCloseTo(7 / 60, 5);
  });

  it("die erfolgreichere Richtung wird öfter gewählt, die schwächere nicht nie", () => {
    const list = [a(1, { sent: 100, replies: 12 }), a(2, { sent: 100, replies: 2 })], r = rng(7);
    const n = { 1: 0, 2: 0 } as Record<number, number>;
    for (let i = 0; i < 1000; i++) n[pickAngles(list, 1, r)[0].id]++;
    expect(n[1]).toBeGreaterThan(900);
    expect(n[2]).toBeGreaterThan(0);
  });

  it("neue Richtungen ohne Daten werden ausprobiert", () => {
    const list = [a(1, { sent: 200, replies: 10 }), a(2, { rounds: 0 })], r = rng(3);
    let fresh = 0;
    for (let i = 0; i < 1000; i++) if (pickAngles(list, 1, r)[0].id === 2) fresh++;
    expect(fresh).toBeGreaterThan(150);
  });

  it("mehrere Richtungen pro Runde ohne Doppelte, nur aktive", () => {
    const got = pickAngles([a(1), a(2), a(3, { active: false })], 3, rng(1)).map(x => x.id).sort();
    expect(got).toEqual([1, 2]);
  });

  it("alle 5 Runden neue Vorschläge; bei mehr als 6 aktiven wird die schwächste KI-Richtung pausiert, nie eine eigene", () => {
    expect(rotation([a(1), a(2)], 4).propose).toBe(false);
    expect(rotation([a(1), a(2)], 5).propose).toBe(true);
    expect(rotation([a(1)], 1).propose).toBe(true);
    const many = [a(1, { origin: "nutzer", sent: 100, replies: 0 }), a(2, { sent: 100, replies: 1 }), ...[3, 4, 5, 6, 7].map(i => a(i, { sent: 100, replies: 8 }))];
    expect(rotation(many, 3).retire).toBe(2);
    expect(rotation(many.slice(0, 6), 3).retire).toBeNull();
  });

  it("Startrichtungen aus der Zeile Branchen des Prompts", () => {
    expect(startAngles("Wir verkaufen X.\nBranchen: Tiefbau, Straßenbau; Kanalbau\nRegion: NRW")).toEqual(["Tiefbau", "Straßenbau", "Kanalbau"]);
    expect(startAngles("Ohne Branchenzeile")).toEqual(["Allgemein"]);
  });
});

describe("Laufende Recherche: Runden über den Tag verteilt", () => {
  it("7 bis 18 Uhr, gleichmäßig, eine je Takt, 0 = aus, nie während des Abendlaufs", () => {
    expect(roundsDue(0, 0, 12)).toBe(0);
    expect(roundsDue(6, 0, 6)).toBe(0);
    expect(roundsDue(6, 0, 19)).toBe(0);
    /* 6 Runden auf 12 Stunden: alle zwei Stunden eine, um 7, 9, 11 … Uhr */
    expect(roundsDue(6, 0, 7)).toBe(1);
    expect(roundsDue(6, 1, 7)).toBe(0);
    expect(roundsDue(6, 1, 8)).toBe(0);
    expect(roundsDue(6, 1, 9)).toBe(1);
    expect(roundsDue(6, 2, 9)).toBe(0);
    expect(roundsDue(6, 6, 18)).toBe(0);
    /* 24 Runden: jeder Takt eine, bis 18 Uhr */
    expect(roundsDue(24, 20, 18)).toBe(1);
  });
});
