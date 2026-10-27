import { describe, expect, it } from "vitest";
import { actOf, textOf } from "@/lib/crm-history";

const owners = new Map([["7", "Anna Berg"]]);
const rec = (id: string, properties: Record<string, string>) => ({ id, properties });

describe("textOf", () => {
  it("behält Absätze, entfernt HTML und den Teams-Block", () => {
    expect(textOf("<p>Erstes&nbsp;Gespräch</p><p>Budget <b>ok</b></p><br>________________<p>Microsoft Teams meeting</p>")).toBe("Erstes Gespräch\nBudget ok");
  });
});

describe("actOf", () => {
  it("Anruf mit Richtung, Status, Dauer und Owner", () => {
    const a = actOf("calls", rec("1", { hs_timestamp: "2026-10-01T09:00:00Z", hs_call_title: "Erstkontakt", hs_call_body: "<p>will Demo</p>", hs_call_direction: "OUTBOUND",
      hs_call_status: "COMPLETED", hs_call_duration: "125000", hubspot_owner_id: "7" }), owners, false);
    expect(a).toMatchObject({ kind: "call", title: "Erstkontakt", text: "will Demo", by: "Anna Berg", meta: "ausgehend · geführt · 2:05 min", src: "HubSpot" });
    expect(a).not.toHaveProperty("co");
  });
  it("Meeting zählt ab Beginn, nur an der Firma erfasst", () => {
    const a = actOf("meetings", rec("2", { hs_timestamp: "2026-10-01T00:00:00Z", hs_meeting_start_time: "2026-10-02T08:00:00Z", hs_meeting_end_time: "2026-10-02T08:30:00Z", hs_meeting_outcome: "COMPLETED" }), owners, true);
    expect(a).toMatchObject({ kind: "meeting", at: "2026-10-02T08:00:00Z", meta: "stattgefunden · 10:00–10:30 Uhr", co: true });
  });
  it("eingehende Mail und Notiz; ohne Datum fällt der Eintrag weg", () => {
    expect(actOf("emails", rec("3", { hs_timestamp: "2026-10-03T00:00:00Z", hs_email_direction: "INCOMING_EMAIL", hs_email_subject: "Re: Angebot", hs_email_text: "Passt." }), owners, false))
      .toMatchObject({ kind: "hs-in", title: "Re: Angebot", text: "Passt." });
    expect(actOf("notes", rec("4", { hs_timestamp: "2026-10-04T00:00:00Z", hs_note_body: "Kunde seit 2024" }), owners, false)).toMatchObject({ kind: "note", text: "Kunde seit 2024" });
    expect(actOf("notes", rec("5", { hs_note_body: "x" }), owners, false)).toBeNull();
  });
});
