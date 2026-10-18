import { describe, expect, it } from "vitest";
import { applyMap, columnsOf, splitTable } from "@/lib/lead-columns";

describe("Spaltenzuordnung", () => {
  const text = "Firmenname\tTelefon\tAnsprechpartner\tMail 1\tMail 2\tUmsatz\nMuster GmbH\t0221 1\tHerr Dr. Max Muster\t\tmax@muster.de\t5 Mio\n\t\t\t\t\t\nBau AG\t\tIda Bau\tida@bau.de\t\t";
  it("erkennt Tabelle und schlägt Felder aus den Spaltennamen vor, mit Beispielwerten", () => {
    const t = splitTable(text)!;
    const cols = columnsOf(t);
    expect(cols.map(c => c.field)).toEqual(["co", "", "name", "", "", ""]);
    expect(cols[0].samples).toEqual(["Muster GmbH", "Bau AG"]);
  });
  it("ignoriert nicht zugeordnete Spalten, erste volle Spalte gewinnt, Zeilen ohne Firma fallen weg", () => {
    const rows = applyMap(splitTable(text)!, ["co", "", "name", "email", "email", ""]);
    expect(rows).toEqual([
      { co: "Muster GmbH", sal: "Herr Dr.", p: "Max Muster", role: "", email: "max@muster.de", web: "", city: "", li: "", hook: "", url: "" },
      { co: "Bau AG", sal: "", p: "Ida Bau", role: "", email: "ida@bau.de", web: "", city: "", li: "", hook: "", url: "" },
    ]);
  });
  it("Freitext mit Kommas ist keine Tabelle", () => {
    expect(splitTable("Muster GmbH, Berlin\nBau AG, Köln")).toBeNull();
    expect(splitTable("Firma,Ort\nMuster GmbH,Berlin")).not.toBeNull();
  });
});
