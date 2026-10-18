import { describe, expect, it } from "vitest";
import { readSignature, signatureOf } from "@/lib/signature";

const SIG = `Dr. Anna Müller
Leiterin Einkauf

Müller Bau GmbH & Co. KG
Hauptstraße 12
80331 München
Tel.: +49 89 123456-0
Mobil: 0171 2345678
www.mueller-bau.de
https://www.linkedin.com/in/anna-mueller-123

Geschäftsführer: Hans Müller | Amtsgericht München HRB 12345`;

const outlook = `Hallo Herr Fink,\n\ndanke für die Unterlagen.\n\nMit freundlichen Grüßen\n\n${SIG}\n\nVon: Niklas Fink <niklas@vergabehero.eu>\nGesendet: Montag, 12. Oktober 2026 10:00\nAn: Anna Müller\nBetreff: Angebot\n\nHallo Frau Müller, anbei das Angebot.`;
const reply = `Kurze Rückfrage: passt Donnerstag?\n\nBeste Grüße\n${SIG}\n\nAm 10.10.2026 um 09:12 schrieb Niklas Fink <niklas@vergabehero.eu>:\n> Hallo\n> Viele Grüße\n> Niklas`;

describe("Signaturen", () => {
  it("nimmt den Block nach der Grußformel und lässt den zitierten Verlauf weg", () => {
    const s = signatureOf([outlook]);
    expect(s).toMatch(/^Dr\. Anna Müller/);
    expect(s).not.toMatch(/Niklas|Angebot/);
  });

  it("nimmt bei mehreren Mails die Zeilen, mit denen jede endet", () => {
    const s = signatureOf([reply, outlook]);
    expect(s.split("\n")[0]).toBe("Dr. Anna Müller");
    expect(s).toMatch(/HRB 12345$/);
  });

  it("liest Firma, Rolle, Telefon, Mobil, Website, LinkedIn und Adresse", () => {
    const d = readSignature(signatureOf([outlook]), "Anna Müller", "anna.mueller@mueller-bau.de");
    expect(d).toMatchObject({ first: "Anna", last: "Müller", role: "Leiterin Einkauf", company: "Müller Bau GmbH & Co. KG", phone: "+49 89 123456-0", mobile: "0171 2345678",
      website: "https://www.mueller-bau.de", linkedin: "https://www.linkedin.com/in/anna-mueller-123", street: "Hauptstraße 12", city: "München" });
  });

  it("englische Signatur ohne Telefon-App-Zeile", () => {
    const s = signatureOf(["Hi,\n\nsounds good.\n\nBest regards,\nJohn Smith\nCTO | Acme Ltd.\n+44 20 7946 0958\n\nSent from my iPhone"]);
    expect(s).not.toMatch(/iPhone/);
    expect(readSignature(s, "John Smith", "john@acme.co.uk")).toMatchObject({ role: "CTO", company: "Acme Ltd.", phone: "+44 20 7946 0958", website: "https://acme.co.uk" });
  });
});
