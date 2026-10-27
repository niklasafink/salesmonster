import { hubspotAccount, hubspotAssociated, hubspotContactByEmail, hubspotDealStages, hubspotOwners, hubspotRead, hubspotToken, type HsContact } from "./hubspot";

/* What HubSpot knows about one contact, read live when the contact dialog opens: the record's properties, its company's,
   its deals and every call, meeting, note, email and task logged on the contact or its company. Nothing of it is stored */

export type HistAct = { id: string; at: string; kind: string; title: string; text?: string; by?: string; meta?: string; src?: string; co?: boolean };
export type HsDeal = { name: string; stage: string; amount: string; close: string; url: string };
export type HsInfo = { url: string; coUrl: string; person: [string, string][]; company: [string, string][]; deals: HsDeal[] };

const KINDS = {
  calls: ["hs_timestamp", "hs_call_title", "hs_call_body", "hs_call_status", "hs_call_direction", "hs_call_duration", "hubspot_owner_id"],
  meetings: ["hs_timestamp", "hs_meeting_title", "hs_meeting_body", "hs_internal_meeting_notes", "hs_meeting_outcome", "hs_meeting_start_time", "hs_meeting_end_time", "hubspot_owner_id"],
  notes: ["hs_timestamp", "hs_note_body", "hubspot_owner_id"],
  emails: ["hs_timestamp", "hs_email_subject", "hs_email_text", "hs_email_html", "hs_email_direction", "hs_email_from_email", "hs_email_to_email", "hubspot_owner_id"],
  tasks: ["hs_timestamp", "hs_task_subject", "hs_task_body", "hs_task_status", "hs_task_priority", "hubspot_owner_id"],
} as const;
type Kind = keyof typeof KINDS;

const PERSON: [string, string][] = [["lifecyclestage", "Lifecycle"], ["hs_lead_status", "Lead-Status"], ["hubspot_owner_id", "Zuständig"], ["mobilephone", "Mobil"],
  ["hs_analytics_source", "Herkunft"], ["recent_conversion_event_name", "Letzte Conversion"], ["createdate", "Angelegt"], ["notes_last_contacted", "Letzter Kontakt"],
  ["notes_next_activity_date", "Nächste Aktivität"], ["num_contacted_notes", "Kontaktversuche"]];
const COMPANY: [string, string][] = [["industry", "Branche"], ["numberofemployees", "Mitarbeitende"], ["annualrevenue", "Umsatz"], ["phone", "Telefon"], ["address", "Straße"],
  ["zip", "PLZ"], ["city", "Ort"], ["lifecyclestage", "Lifecycle"], ["hubspot_owner_id", "Zuständig"], ["hs_num_open_deals", "Offene Deals"], ["description", "Beschreibung"]];
const DEAL = ["dealname", "dealstage", "amount", "closedate"];

const LIFE: Record<string, string> = { subscriber: "Abonnent", lead: "Lead", marketingqualifiedlead: "MQL", salesqualifiedlead: "SQL", opportunity: "Opportunity", customer: "Kunde", evangelist: "Fürsprecher", other: "Sonstiges" };
const LEAD_ST: Record<string, string> = { NEW: "Neu", OPEN: "Offen", IN_PROGRESS: "In Bearbeitung", OPEN_DEAL: "Offener Deal", UNQUALIFIED: "Nicht qualifiziert", ATTEMPTED_TO_CONTACT: "Kontaktversuch", CONNECTED: "Erreicht", BAD_TIMING: "Falscher Zeitpunkt" };
const SOURCE: Record<string, string> = { ORGANIC_SEARCH: "Organische Suche", PAID_SEARCH: "Bezahlte Suche", EMAIL_MARKETING: "E-Mail-Marketing", SOCIAL_MEDIA: "Social Media", REFERRALS: "Verweis", OTHER_CAMPAIGNS: "Kampagne", DIRECT_TRAFFIC: "Direkt", OFFLINE: "Offline", PAID_SOCIAL: "Bezahlte Social Ads", AI_REFERRALS: "KI-Verweis" };
const CALL_ST: Record<string, string> = { COMPLETED: "geführt", NO_ANSWER: "nicht erreicht", BUSY: "besetzt", FAILED: "fehlgeschlagen", CANCELED: "abgebrochen", QUEUED: "geplant", IN_PROGRESS: "läuft", RINGING: "klingelt" };
const MEET_ST: Record<string, string> = { SCHEDULED: "geplant", COMPLETED: "stattgefunden", RESCHEDULED: "verschoben", NO_SHOW: "nicht erschienen", CANCELED: "abgesagt" };
const TASK_ST: Record<string, string> = { NOT_STARTED: "offen", IN_PROGRESS: "in Arbeit", WAITING: "wartet", DEFERRED: "zurückgestellt", COMPLETED: "erledigt" };
const PRIO: Record<string, string> = { HIGH: "hohe Priorität", MEDIUM: "", LOW: "" };

const TZ = { timeZone: "Europe/Berlin" } as const;
const date = (v: string) => { const d = Date.parse(v); return Number.isFinite(d) ? new Date(d).toLocaleDateString("de-DE", TZ) : v; };
const time = (v: string) => new Date(Date.parse(v)).toLocaleTimeString("de-DE", { ...TZ, hour: "2-digit", minute: "2-digit" });
const euro = (v: string) => Number.isFinite(Number(v)) ? Number(v).toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }) : v;

/* HTML of notes and mails as text with its line breaks, without the video-call block of invites */
export const textOf = (s: string) => s.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .split(/_{10,}|Microsoft Teams (meeting|Besprechung)|Join:|Meeting ID/i)[0]
  .split("\n").map(l => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();

function value(k: string, v: string, owners: Map<string, string>) {
  if (k === "lifecyclestage") return LIFE[v] || v;
  if (k === "hs_lead_status") return LEAD_ST[v] || v;
  if (k === "hs_analytics_source") return SOURCE[v] || v;
  if (k === "hubspot_owner_id") return owners.get(v) || "";
  if (k === "annualrevenue") return euro(v);
  if (/date$|^notes_/.test(k)) return date(v);
  return v;
}
const fields = (rec: HsContact | undefined, list: [string, string][], owners: Map<string, string>) =>
  list.map(([k, l]) => [l, value(k, (rec?.properties[k] || "").trim(), owners)] as [string, string]).filter(([, v]) => v);

/* one HubSpot activity as a timeline entry */
export function actOf(kind: Kind, x: HsContact, owners: Map<string, string>, co: boolean): HistAct | null {
  const p = (k: string) => (x.properties[k] || "").trim(), by = owners.get(p("hubspot_owner_id")) || undefined;
  const base = { id: `${kind}:${x.id}`, at: p("hs_timestamp"), by, src: "HubSpot", ...(co ? { co } : {}) };
  if (!base.at) return null;
  const meta = (...m: (string | undefined)[]) => m.filter(Boolean).join(" · ") || undefined;
  if (kind === "calls") {
    const s = Math.round(Number(p("hs_call_duration")) / 1000);
    return { ...base, kind: "call", title: p("hs_call_title") || "Anruf", text: textOf(p("hs_call_body")) || undefined,
      meta: meta(p("hs_call_direction") === "INBOUND" ? "eingehend" : p("hs_call_direction") ? "ausgehend" : "", CALL_ST[p("hs_call_status")], s > 0 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} min` : "") };
  }
  if (kind === "meetings") {
    const start = p("hs_meeting_start_time") || base.at, end = p("hs_meeting_end_time");
    return { ...base, at: start, kind: "meeting", title: p("hs_meeting_title") || "Meeting",
      text: [textOf(p("hs_internal_meeting_notes")), textOf(p("hs_meeting_body"))].filter(Boolean).join("\n\n") || undefined,
      meta: meta(MEET_ST[p("hs_meeting_outcome")] || p("hs_meeting_outcome").toLowerCase(), `${time(start)}${end ? `–${time(end)}` : ""} Uhr`) };
  }
  if (kind === "notes") return { ...base, kind: "note", title: "Notiz", text: textOf(p("hs_note_body")) || undefined };
  if (kind === "emails") {
    const inc = p("hs_email_direction") === "INCOMING_EMAIL";
    return { ...base, kind: inc ? "hs-in" : "hs-out", title: p("hs_email_subject") || (inc ? "E-Mail erhalten" : "E-Mail gesendet"),
      text: (p("hs_email_text") || textOf(p("hs_email_html"))).trim() || undefined, meta: meta(inc ? "erhalten" : "gesendet", [p("hs_email_from_email"), p("hs_email_to_email")].filter(Boolean).join(" → ")) };
  }
  return { ...base, kind: "task", title: p("hs_task_subject") || "Aufgabe", text: textOf(p("hs_task_body")) || undefined, meta: meta("Aufgabe", TASK_ST[p("hs_task_status")], PRIO[p("hs_task_priority")]) };
}

/* the contact by its HubSpot id, else by address; null when the tenant has no HubSpot or the person is not in it */
export async function crmHistory(tenantId: number, l: { hsContactId: string; email: string }, companyHsId: string): Promise<{ acts: HistAct[]; hs: HsInfo | null; error?: string }> {
  const token = await hubspotToken(tenantId);
  if (!token) return { acts: [], hs: null };
  try {
    /* the lookups start alongside the search for the contact */
    const look = Promise.all([hubspotAccount(token), hubspotOwners(token), hubspotDealStages(token)]);
    look.catch(() => {});
    const id = l.hsContactId || (l.email ? await hubspotContactByEmail(token, l.email) : null);
    if (!id && !companyHsId) return { acts: [], hs: null };
    const [[acc, owners, stages], [person]] = await Promise.all([look,
      id ? hubspotRead(token, "contacts", [id], [...PERSON.map(([k]) => k), "associatedcompanyid"]) : Promise.resolve([] as HsContact[])]);
    const coId = companyHsId || (person?.properties.associatedcompanyid || "").trim();
    const kinds = Object.keys(KINDS) as Kind[];
    /* per kind: ids on the contact, then ids on the company; what only hangs on the company is marked as such */
    const [mine, theirs, dealIds, [company]] = await Promise.all([
      Promise.all(kinds.map(k => id ? hubspotAssociated(token, "contacts", id, k).catch(() => []) : [])),
      Promise.all(kinds.map(k => coId ? hubspotAssociated(token, "companies", coId, k).catch(() => []) : [])),
      id ? hubspotAssociated(token, "contacts", id, "deals").catch(() => []) : coId ? hubspotAssociated(token, "companies", coId, "deals").catch(() => []) : [],
      coId ? hubspotRead(token, "companies", [coId], COMPANY.map(([k]) => k)).catch(() => []) : Promise.resolve([] as HsContact[]),
    ]);
    const acts = (await Promise.all(kinds.map(async (k, i) => {
      const own = new Set(mine[i]), ids = [...new Set([...mine[i], ...theirs[i]])];
      const recs = ids.length ? await hubspotRead(token, k, ids, [...KINDS[k]]) : [];
      return recs.map(x => actOf(k, x, owners, !own.has(String(x.id))));
    }))).flat().filter((a): a is HistAct => !!a);
    const deals = (dealIds.length ? await hubspotRead(token, "deals", dealIds, DEAL) : []).map(d => {
      const p = (k: string) => (d.properties[k] || "").trim();
      return { name: p("dealname") || "Deal", stage: stages.get(p("dealstage")) || p("dealstage"), amount: p("amount") ? euro(p("amount")) : "", close: p("closedate") ? date(p("closedate")) : "",
        url: `https://${acc.ui}/contacts/${acc.portal}/record/0-3/${d.id}` };
    });
    return { acts, hs: {
      url: id ? `https://${acc.ui}/contacts/${acc.portal}/record/0-1/${id}` : "", coUrl: coId ? `https://${acc.ui}/contacts/${acc.portal}/record/0-2/${coId}` : "",
      person: fields(person, PERSON, owners), company: fields(company, COMPANY, owners), deals } };
  } catch (e) {
    return { acts: [], hs: null, error: (e as Error).message };
  }
}
