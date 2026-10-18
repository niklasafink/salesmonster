import { describe, expect, it } from "vitest";
import { parseCsv, toTsv, tsvChunks } from "@/lib/sheet";

describe("parseCsv", () => {
  it("liest Komma-CSV mit Anführungszeichen", () => {
    expect(parseCsv('Firma,Ort\n"Muster GmbH, Berlin",Köln\n')).toEqual([["Firma", "Ort"], ["Muster GmbH, Berlin", "Köln"]]);
  });
  it("erkennt Semikolon trotz Kommas in Anführungszeichen, mit BOM, CRLF und Zeilenumbruch im Feld", () => {
    expect(parseCsv('﻿Firma;Notiz\r\n"Bau AG, Nord";"sagt ""Hallo""\nzweite Zeile"\r\n')).toEqual([["Firma", "Notiz"], ["Bau AG, Nord", 'sagt "Hallo"\nzweite Zeile']]);
  });
  it("erkennt Tabulator", () => {
    expect(parseCsv("Firma\tOrt\nA GmbH\tUlm")).toEqual([["Firma", "Ort"], ["A GmbH", "Ulm"]]);
  });
});

describe("toTsv", () => {
  it("schreibt Kopfzeile und Zeilen, Zellen ohne Tab und Umbruch, leere Zeilen fallen weg", () => {
    const rows = [["Firma", "Seit", "MA", null], ["", null, "", ""], [" A GmbH ", new Date(Date.UTC(2024, 2, 5)), 12, "Zeile 1\nZeile\t2"]];
    expect(toTsv(rows)).toBe("Firma\tSeit\tMA\t\nA GmbH\t05.03.2024\t12\tZeile 1 Zeile 2");
  });
  it("meldet leere Datei", () => {
    expect(() => toTsv([])).toThrow("Datei ist leer");
    expect(() => toTsv([["Firma", "Ort"], ["", ""]])).toThrow("Datei ist leer");
  });
  it("meldet mehr als 1.000 Datenzeilen", () => {
    const head = [["Firma"]], rows = (n: number) => Array.from({ length: n }, (_, i) => [`F${i}`]);
    expect(toTsv([...head, ...rows(1000)]).split("\n")).toHaveLength(1001);
    expect(() => toTsv([...head, ...rows(1001)])).toThrow("Mehr als 1.000 Datenzeilen");
  });
});

describe("tsvChunks", () => {
  it("teilt Tabellen in Stücke mit wiederholter Kopfzeile, nichts geht verloren", () => {
    const rows = Array.from({ length: 250 }, (_, i) => `Firma ${i} GmbH\tOrt ${i}`), text = ["Firma\tOrt", ...rows].join("\n");
    const parts = tsvChunks(text, 120);
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(p.split("\n")[0]).toBe("Firma\tOrt");
    expect(parts.flatMap(p => p.split("\n").slice(1))).toEqual(rows);
  });
  it("Freitext bleibt ein Stück", () => {
    expect(tsvChunks("Muster GmbH - GF: Ida Muster\nBau AG", 120)).toEqual(["Muster GmbH - GF: Ida Muster\nBau AG"]);
  });
});
