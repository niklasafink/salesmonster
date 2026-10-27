import { createHash } from "node:crypto";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { db, leads, mailContacts } from "@/db";
import type { Touch } from "@/db/schema";
import { hubspotActivities, hubspotToken, type HsActivity } from "./hubspot";
import { JevLimit, jevKey, judgeTouches } from "./jev";

/* Whether we had individual contact with a person: a demo, a phone call or a personal mail, as Jev reads the activities HubSpot logged for them,
   plus the mails in the team's connected mailboxes. All activities are read each run (a few hundred to a few thousand);
   Jev only reads a contact again when their activities changed (hash). */
const KINDS = {
  calls: { label: "Anruf", props: ["hs_timestamp", "hs_call_title", "hs_call_body", "hs_call_status", "hs_call_direction"], title: "hs_call_title", body: "hs_call_body", extra: "hs_call_status" },
  meetings: { label: "Meeting", props: ["hs_timestamp", "hs_meeting_title", "hs_meeting_body", "hs_meeting_outcome"], title: "hs_meeting_title", body: "hs_meeting_body", extra: "hs_meeting_outcome" },
  notes: { label: "Notiz", props: ["hs_timestamp", "hs_note_body"], title: "", body: "hs_note_body", extra: "" },
  emails: { label: "E-Mail", props: ["hs_timestamp", "hs_email_subject", "hs_email_text", "hs_email_direction"], title: "hs_email_subject", body: "hs_email_text", extra: "hs_email_direction" },
} as const;
type Kind = keyof typeof KINDS;
export type Act = { kind: Kind; at: number; title: string; body: string; extra: string };

const MAX_ACTS = 15, BODY = 400, PARALLEL = 6, MAX_JUDGE = 150, YES = 0.5;

/* HTML of meeting invites and mails down to its words, without the video-call block */
export const plain = (s: string) => s.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .split(/_{10,}|Microsoft Teams (meeting|Besprechung)|Join:|Meeting ID/i)[0].replace(/\s+/g, " ").trim();

const DIR: Record<string, string> = { EMAIL: "ausgehend", INCOMING_EMAIL: "eingehend", FORWARDED_EMAIL: "weitergeleitet" };
const day = (ms: number) => new Date(ms).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" });

/* what Jev reads: the newest activities first, each with kind, date (future marked), status and the start of its text */
export function activityText(acts: Act[], now: Date) {
  return [...acts].sort((a, b) => b.at - a.at).slice(0, MAX_ACTS).map(a => {
    const head = [KINDS[a.kind].label, a.kind === "emails" ? DIR[a.extra] || a.extra : a.extra.toLowerCase(), day(a.at), a.at > now.getTime() ? "in der Zukunft" : "vergangen"].filter(Boolean).join(", ");
    const body = plain(a.body).slice(0, BODY);
    return `- [${head}] ${a.title}${body ? `: ${body}` : ""}`;
  }).join("\n");
}

/* what the sales team wrote down in calls and notes, for the company profile (e.g. "1-Mann-Betrieb", "ist Auftraggeber") */
export const notesOf = (acts: Act[], now: Date) => acts.filter(a => (a.kind === "calls" || a.kind === "notes") && a.at <= now.getTime())
  .sort((a, b) => b.at - a.at).map(a => plain(a.body)).filter(Boolean).join(" · ").slice(0, 500);

const toAct = (kind: Kind, x: HsActivity): Act => {
  const k = KINDS[kind], p = (n: string) => (n ? x.properties[n] : "") || "";
  return { kind, at: Date.parse(p("hs_timestamp")) || 0, title: p(k.title), body: p(k.body), extra: p(k.extra) };
};

export type TouchRun = { contacts: number; judged: number; failed: number; error?: string };
type Box = NonNullable<Touch["box"]>;

/* a mail one of us wrote to the person, or one they wrote to us directly, is individual contact by mail */
export const boxMail = (b?: Box | null) => !!b && (b.sent > 0 || b.direct > 0);

/* Individual contact per person: Jev reads the HubSpot activities of contacts that have some; the team's mailboxes count for everyone with an address */
export async function syncTouches(tenantId: number, now = new Date()): Promise<TouchRun> {
  const [token, key, boxes] = await Promise.all([hubspotToken(tenantId), jevKey(tenantId),
    db.select({ email: sql<string>`lower(${mailContacts.email})`, sent: sql<number>`sum(${mailContacts.sent})::int`, direct: sql<number>`sum(${mailContacts.direct})::int`, last: sql<string | null>`max(${mailContacts.lastAt})` })
      .from(mailContacts).where(eq(mailContacts.tenantId, tenantId)).groupBy(sql`lower(${mailContacts.email})`)]);
  const boxOf = new Map(boxes.map(b => [b.email, { sent: b.sent, direct: b.direct, last: b.last ? new Date(b.last).toISOString() : null }]));
  const people = (await db.select({ id: leads.id, hs: leads.hsContactId, email: leads.email, touch: leads.touch }).from(leads)
    .where(and(eq(leads.tenantId, tenantId), or(ne(leads.hsContactId, ""), ne(leads.email, ""))))).filter(p => p.hs || boxOf.has(p.email.toLowerCase()) || p.touch);
  if (!people.length) return { contacts: 0, judged: 0, failed: 0 };

  /* activities per HubSpot contact; a kind the token may not read is skipped and reported */
  const byContact = new Map<string, Act[]>();
  let error: string | undefined;
  if (token) for (const kind of Object.keys(KINDS) as Kind[]) {
    try {
      for (const x of await hubspotActivities(token, kind, [...KINDS[kind].props]))
        for (const c of x.associations?.contacts?.results || []) byContact.set(String(c.id), [...(byContact.get(String(c.id)) || []), toAct(kind, x)]);
    } catch (e) { error = `${KINDS[kind].label}: ${(e as Error).message}`; console.error("touches", tenantId, error); }
  }

  const rows: [number, Touch][] = [], ask: { id: number; text: string; base: Omit<Touch, "demo" | "call" | "mail"> }[] = [];
  const at = now.toISOString();
  for (const p of people) {
    const acts = p.hs ? byContact.get(p.hs) || [] : [], box = boxOf.get(p.email.toLowerCase());
    const text = activityText(acts, now);
    const hash = acts.length || box ? createHash("sha1").update(JSON.stringify([text, box ?? null])).digest("hex").slice(0, 16) : "0";
    if (p.touch?.hash === hash) continue;
    const past = [...acts.filter(a => a.at && a.at <= now.getTime()).map(a => a.at), ...(box?.last ? [Date.parse(box.last)] : [])];
    const base = { n: acts.length, last: past.length ? new Date(Math.max(...past)).toISOString() : null, notes: notesOf(acts, now), hash, at, ...(box ? { box } : {}) };
    /* Jev reads the activities, unless the mailbox already settled the only question they could answer */
    if (!acts.length) rows.push([p.id, { demo: false, call: false, mail: boxMail(box), ...base }]);
    else if (key) ask.push({ id: p.id, text, base });
  }
  let judged = 0, failed = 0;
  const list = ask.slice(0, MAX_JUDGE);
  for (let i = 0; i < list.length; i += PARALLEL) {
    await Promise.all(list.slice(i, i + PARALLEL).map(async a => {
      try {
        const j = await judgeTouches(key!, a.text);
        rows.push([a.id, { demo: j.demo >= YES, call: j.call >= YES, mail: j.mail >= YES || boxMail(a.base.box), ...a.base }]);
        judged++;
      } catch (e) { failed++; if (e instanceof JevLimit || !error) error = (e as Error).message; }
    }));
  }
  for (let i = 0; i < rows.length; i += 500) {
    const values = sql.join(rows.slice(i, i + 500).map(([id, t]) => sql`(${id}::int, ${JSON.stringify(t)}::jsonb)`), sql`, `);
    await db.execute(sql`update leads set touch = v.t from (values ${values}) as v(id, t) where leads.id = v.id`);
  }
  return { contacts: people.length, judged, failed, ...(error ? { error } : {}) };
}
