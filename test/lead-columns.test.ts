import { describe, expect, it } from "vitest";
import { applyMap, columnsOf, splitTable } from "@/lib/lead-columns";

describe("Spaltenzuordnung", () => {
  const text = "Firmenname\tTelefon\tAnsprechpartner\tMail 1\tMail 2\tUmsatz\nMuster GmbH\t0221 1\tHerr Dr. Max Muster\t\tmax@muster.de\t5 Mio\n\t\t\t\t\t\nBau AG\t\tIda Bau\tida@bau.de\t\t";
  it("erkennt Tabelle und schlägt Felder aus den Spaltennamen vor, mit Beispielwerten", () => {
    const t = splitTable(text)!;
    const cols = columnsOf(t);
    expect(cols.map(c => c.field)).toEqual(["co", "phone", "name", "", "", ""]);
    expect(cols[0].samples).toEqual(["Muster GmbH", "Bau AG"]);
  });
  it("ignoriert nicht zugeordnete Spalten, erste volle Spalte gewinnt, Zeilen ohne Firma fallen weg", () => {
    const rows = applyMap(splitTable(text)!, ["co", "", "name", "email", "email", ""]);
    expect(rows).toEqual([
      { co: "Muster GmbH", sal: "Herr Dr.", p: "Max Muster", role: "", email: "max@muster.de", phone: "", web: "", city: "", li: "", hook: "", url: "", note: "" },
      { co: "Bau AG", sal: "", p: "Ida Bau", role: "", email: "ida@bau.de", phone: "", web: "", city: "", li: "", hook: "", url: "", note: "" },
    ]);
  });
  it("Telefon wird übernommen, mehrere Nummern einer Person bleiben zusammen", () => {
    const t = splitTable("Firma\tName\tTelefon\tMobil\nMuster GmbH\tMax Muster\t069 / 96765\t+49 152 01234567")!;
    expect(applyMap(t, ["co", "name", "phone", "phone"])[0].phone).toBe("069 / 96765 / +49 152 01234567");
  });
  it("zwei Personen in einer Zeile: jede bekommt ihre Nummer und Adresse in derselben Reihenfolge", () => {
    const t = splitTable("Firma\tAnsprechpartner A\tAnsprechpartner B\tTelefon\tE-Mail\tOrt\nMuster GmbH\tHerr Max Muster\tFrau Ida Bau\t+49 69 967 65 1141 / +49 152 01 234567\tmax@muster.de; ida@muster.de\tFrankfurt")!;
    const rows = applyMap(t, ["co", "name", "name", "phone", "email", "city"]);
    expect(rows.map(r => [r.sal, r.p, r.phone, r.email, r.city])).toEqual([
      ["Herr", "Max Muster", "+49 69 967 65 1141", "max@muster.de", "Frankfurt"],
      ["Frau", "Ida Bau", "+49 152 01 234567", "ida@muster.de", "Frankfurt"],
    ]);
  });
  it("zwei Namen in einer Zelle, eine Zentrale: die Nummer gilt für beide, die Rolle nur für die erste Person", () => {
    const t = splitTable("Firma\tName\tTelefon\tRolle\nBau AG\tMax Muster / Ida Bau\t0221 123456\tGeschäftsführer")!;
    expect(applyMap(t, ["co", "name", "phone", "role"]).map(r => [r.p, r.phone, r.role])).toEqual([["Max Muster", "0221 123456", "Geschäftsführer"], ["Ida Bau", "0221 123456", ""]]);
  });
  it("Freitext mit Kommas ist keine Tabelle", () => {
    expect(splitTable("Muster GmbH, Berlin\nBau AG, Köln")).toBeNull();
    expect(splitTable("Firma,Ort\nMuster GmbH,Berlin")).not.toBeNull();
  });
});
