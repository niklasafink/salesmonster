import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safe-next";
import { lint, nextKey, unknownPlaceholders } from "@/lib/playbook";

describe("safeNext", () => {
  const o = "https://portal.example", n = (v: string) => `?${new URLSearchParams({ next: v })}`;
  it("behält eigene Pfade mit Query und Hash", () => {
    expect(safeNext(n("/api/oauth/authorize?a=1&b=2#x"), o)).toBe("/api/oauth/authorize?a=1&b=2#x");
    expect(safeNext(n("/freigabe"), o)).toBe("/freigabe");
  });
  it("fremde Ziele → /", () => {
    for (const s of ["?next=/%09/evil.example", "?next=%2F%0A%2Fevil.example", n("//evil.example"), n("/\\evil.example"), n("https://evil.example/x"), n("javascript:alert(1)"), "", "?next="])
      expect([s, safeNext(s, o)]).toEqual([s, "/"]);
  });
});

describe("Platzhalter", () => {
  it("eine Prüfung für lint und templates_save, auch mit Leerzeichen oder Großbuchstaben", () => {
    expect(unknownPlaceholders("{{anrede}} {{ Firma }} {{name}} {{name}}", ["{{anrede}}"])).toEqual(["{{ Firma }}", "{{name}}"]);
    expect(lint("x", "{{anrede}} {{ Firma }}", ["{{anrede}}"])).toContain("unbekannt: {{ Firma }}");
  });
  it("nächster freier key: A…Z, dann AA, AB …", () => {
    expect(nextKey(new Set(["A", "B", "D"]))).toBe("C");
    expect(nextKey(new Set(Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))))).toBe("AA");
  });
});
