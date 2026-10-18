import { describe, expect, it } from "vitest";
import { batchDays, daysText, draftDay, planOf, sendQuota } from "@/lib/schedule";

const p = planOf({}), sun = new Date("2026-10-18T10:00:00Z"), fri = new Date("2026-10-23T10:00:00Z");

describe("Versandplan", () => {
  it("Sonntag: die ersten zehn gehen Montag raus, die nächsten Dienstag", () => {
    expect(batchDays(p, 2, false, sun)).toEqual(["2026-10-19", "2026-10-20"]);
    expect(batchDays(p, 1, true, sun)).toEqual(["2026-10-20"]);
  });
  it("Freitag: ohne Wochenende geht es Montag weiter, mit Wochenende Samstag", () => {
    expect(batchDays(p, 1, false, fri)).toEqual(["2026-10-26"]);
    expect(batchDays(planOf({ sendDays: [1, 2, 3, 4, 5, 6, 7] }), 1, false, fri)).toEqual(["2026-10-24"]);
  });
  it("Entwürfe gehen am Versandtag nach ihrem Abend raus, nach dem Zeitfenster am nächsten", () => {
    expect(draftDay(p, "2026-10-18", sun)).toBe("2026-10-19");
    expect(draftDay(p, "2026-10-22", fri)).toBe("2026-10-26");
  });
  it("im Zeitfenster gleich verteilt, in der letzten Stunde der Rest, außerhalb nichts", () => {
    expect(sendQuota(p, 10, new Date("2026-10-19T05:30:00Z"))).toBe(0);
    expect(sendQuota(p, 10, new Date("2026-10-19T06:30:00Z"))).toBe(5);
    expect(sendQuota(p, 10, new Date("2026-10-19T07:30:00Z"))).toBe(10);
    expect(sendQuota(p, 10, new Date("2026-10-19T08:30:00Z"))).toBe(0);
    expect(sendQuota(p, 10, new Date("2026-10-18T07:30:00Z"))).toBe(0);
  });
  it("Tage als Text", () => {
    expect(daysText([1, 2, 3, 4, 5])).toBe("Mo–Fr");
    expect(daysText([7, 1, 2, 3, 4])).toBe("So–Do");
    expect(daysText([1, 3, 5])).toBe("Mo, Mi, Fr");
  });
});
