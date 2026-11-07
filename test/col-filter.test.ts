import { describe, expect, it } from "vitest";
import { compare, filterText, isOn, passes, withFilter } from "@/lib/col-filter";

describe("column filters", () => {
  it("keeps rows with or without a value", () => {
    expect(passes("a@x.de", { has: "ja" })).toBe(true);
    expect(passes("", { has: "ja" })).toBe(false);
    expect(passes("  ", { has: "nein" })).toBe(true);
    expect(passes(null, { has: "nein" })).toBe(true);
    expect(passes("https://linkedin.com/in/max", { has: "nein" })).toBe(false);
  });
  it("searches accent- and umlaut-insensitive, word by word", () => {
    expect(passes("Müller Bau GmbH", { q: "mueller gmbh" })).toBe(true);
    expect(passes("Müller Bau GmbH", { q: "schmidt" })).toBe(false);
    expect(passes("", { q: "x" })).toBe(false);
    expect(passes("egal", { q: "   " })).toBe(true);
  });
  it("picks an exact value", () => {
    expect(passes("Warm", { v: "Warm" })).toBe(true);
    expect(passes("Kalt", { v: "Warm" })).toBe(false);
  });
  it("sorts empty values last in both directions", () => {
    const v = ["b", "", "a", null, "Firma 10", "Firma 2"];
    expect([...v].sort((x, y) => compare(x, y, false))).toEqual(["a", "b", "Firma 2", "Firma 10", "", null]);
    expect([...v].sort((x, y) => compare(x, y, true)).slice(0, 4)).toEqual(["Firma 10", "Firma 2", "b", "a"]);
    expect([3, null, 10, 1].sort((x, y) => compare(x, y, true))).toEqual([10, 3, 1, null]);
  });
  it("drops filters with nothing set", () => {
    expect(withFilter({ a: { has: "ja" } }, "a", {})).toEqual({});
    expect(withFilter({}, "b", { has: undefined, q: "x" })).toEqual({ b: { q: "x" } });
    expect(isOn({ q: " " })).toBe(false);
    expect(filterText("E-Mail", { has: "nein" })).toBe("E-Mail: leer");
  });
});
