import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, enrollments, runs, sequenceMails, sequenceTemplates, sequences, tenants, users, type SeqConfig, type SeqMatch, type SeqStep } from "@/db";
import { aiFor, AiMissing } from "./ai";
import { ask, json } from "./claude";
import { fill, type FillLead } from "./fill";
import { hubspotContactsRead, hubspotContactsWhere, hubspotToken, type HsContact } from "./hubspot";
import { jevKey, scoreMail } from "./jev";
import { salutationOf } from "./lead-fields";
import { hasBounce, hasReply, sendAs } from "./mail";
import { thompson } from "./thompson";
import { track } from "./usage";

type Tenant = typeof tenants.$inferSelect;
type Seq = typeof sequences.$inferSelect;
type Enr = typeof enrollments.$inferSelect;

const DAY = 864e5;
/* mails go out between 08:00 and 19:00 Berlin; a person gets at most one mail per 20 hours */
const HOURS = [8, 19], GAP = 20 * 36e5;
export const OPEN = ["aktiv", "antwort"];

export const PLACEHOLDERS = ["{{anrede}}", "{{vorname}}", "{{nachname}}", "{{firma}}", "{{absender}}"];

const SAMPLE: FillLead = { company: "Muster Bau GmbH", first: "Katrin", last: "Albers", salutation: "Frau", emailType: "person", hook: "", tenders: [] };
export const personOf = (e: Pick<Enr, "company" | "first" | "last" | "salutation">): FillLead =>
  ({ company: e.company, first: e.first, last: e.last, salutation: e.salutation, emailType: "person", hook: "", tenders: [] });

async function log(tenantId: number, ok: boolean, info: string) {
  await db.insert(runs).values({ tenantId, kind: "strecke", ok, info: info.slice(0, 500) });
}

const berlinHour = (d: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hourCycle: "h23" }).format(d));

/* HubSpot value against a rule; empty value = any value, multi-checkbox values are split on ";" */
function matches(v: string | null | undefined, m: SeqMatch) {
  if (!m.property) return false;
  const have = (v ?? "").trim().toLowerCase();
  if (!m.value) return !!have && have !== "false";
  return have.split(";").includes(m.value.trim().toLowerCase());
}

/* Unsubscribe link: id plus a signature, so nobody can unsubscribe someone else */
const sign = (id: number) => createHmac("sha256", `unsub:${process.env.APP_SECRET}`).update(String(id)).digest("base64url").slice(0, 22);
export const unsubToken = (id: number) => `${id}.${sign(id)}`;
export function unsubId(token: string) {
  const [id, s] = token.split(".");
  const n = Number(id), want = Number.isSafeInteger(n) && n > 0 ? sign(n) : "";
  return want && s && s.length === want.length && timingSafeEqual(Buffer.from(s), Buffer.from(want)) ? n : null;
}
const footer = (id: number) => `\n\n--\nKeine weiteren Mails: ${process.env.APP_URL || ""}/api/abmelden?e=${unsubToken(id)}`;

export function defaultSequence(t: Tenant, trialDays = 14) {
  const steps: SeqStep[] = [
    { day: 0, name: "Willkommen" }, { day: 5, name: "Erste Schritte" }, { day: 10, name: "Endspurt" },
    { day: trialDays - 1, name: "Test endet" }, { day: trialDays + 6, name: "Nach dem Test" },
  ];
  const sig = "\n\nViele Grüße\n{{absender}}";
  const left = trialDays - 10;
  const texts: [string, string][] = [
    [`Willkommen bei ${t.name}`, `{{anrede}}\n\ndanke für Ihre Registrierung. Ihr Zugang ist ab heute ${trialDays} Tage lang für alle Pro-Funktionen freigeschaltet.\n\nWofür möchten Sie ${t.name} vor allem nutzen? Wenn Sie mir das in einem Satz schreiben, schicke ich Ihnen den passenden Einstieg.`],
    ["Wie läuft der Test?", `{{anrede}}\n\nSie nutzen ${t.name} jetzt seit fünf Tagen. Wenn Sie bei der Einrichtung irgendwo nicht weiterkommen, antworten Sie einfach auf diese Mail. Ich helfe Ihnen direkt.\n\nWas haben Sie bisher ausprobiert?`],
    [`Noch ${left} Tage Pro`, `{{anrede}}\n\nIhr Pro-Zugang läuft noch ${left} Tage.\n\nIst vor Ihrer Entscheidung noch eine Frage zu ${t.name} offen?`],
    ["Ihr Test endet morgen", `{{anrede}}\n\nmorgen endet Ihr Pro-Test. Danach nutzen Sie ${t.name} in der kostenlosen Version weiter.\n\nMöchten Sie Pro behalten? Dann antworten Sie kurz auf diese Mail, und ich schicke Ihnen Preis und Ablauf.`],
    ["Kurze Frage", `{{anrede}}\n\nIhr Pro-Test ist seit einigen Tagen vorbei. Was hat gefehlt, damit Sie Pro weiter nutzen?\n\nEin Satz als Antwort genügt.`],
  ];
  return { steps, texts: texts.map(([subject, body]) => ({ subject, body: body + sig })) };
}

export async function createSequence(t: Tenant, senderId: number) {
  const trialDays = 14, d = defaultSequence(t, trialDays);
  const config: SeqConfig = { enter: { property: "", value: "" }, bought: { property: "", value: "" }, stop: { property: "", value: "" }, senderId, trialDays, since: new Date().toISOString() };
  const [s] = await db.insert(sequences).values({ tenantId: t.id, name: "Registrierung", steps: d.steps, config }).returning();
  await db.insert(sequenceTemplates).values(d.texts.map((x, step) => ({ sequenceId: s.id, step, key: "A", ...x })));
  return s;
}

/* Per step and variant: sent (without bounces) and replies */
export async function stepStats(sequenceId: number) {
  const rows = await db.select({ step: sequenceMails.step, v: sequenceMails.variant,
    sent: sql<number>`count(*) - count(${sequenceMails.bouncedAt})`.mapWith(Number), replies: sql<number>`count(${sequenceMails.repliedAt})`.mapWith(Number),
    bounced: sql<number>`count(${sequenceMails.bouncedAt})`.mapWith(Number) })
    .from(sequenceMails).where(eq(sequenceMails.sequenceId, sequenceId)).groupBy(sequenceMails.step, sequenceMails.variant);
  return (step: number, v: string) => rows.find(r => r.step === step && r.v === v) ?? { sent: 0, replies: 0, bounced: 0 };
}

async function senderName(id: number | null) {
  if (!id) return "";
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, id));
  return u?.name || "";
}

const PROPS = ["email", "firstname", "lastname", "company", "salutation", "createdate"];

async function enroll(s: Seq, token: string) {
  const c = s.config;
  const found = await hubspotContactsWhere(token, c.enter, c.since, PROPS);
  let n = 0;
  for (const x of found.filter(x => x.properties.email)) {
    const p = x.properties;
    const [row] = await db.insert(enrollments).values({ sequenceId: s.id, hubspotId: x.id, email: p.email!.trim(), first: p.firstname || "", last: p.lastname || "",
      salutation: salutationOf(p.salutation || ""), company: p.company || "", startedAt: new Date(p.createdate || Date.now()) }).onConflictDoNothing().returning({ id: enrollments.id });
    if (row) n++;
  }
  return n;
}

/* Bought, stopped by hand in HubSpot, or opted out of mail there */
async function exits(s: Seq, token: string, open: Enr[]) {
  const c = s.config;
  const props = [c.bought.property, c.stop.property, "hs_email_optout"].filter(Boolean);
  const got = new Map<string, HsContact>((await hubspotContactsRead(token, open.map(e => e.hubspotId), props)).map(x => [x.id, x]));
  let n = 0;
  for (const e of open) {
    const p = got.get(e.hubspotId)?.properties;
    if (!p) continue;
    const status = matches(p[c.bought.property], c.bought) ? "gekauft" : matches(p[c.stop.property], c.stop) ? "beendet" : p.hs_email_optout === "true" ? "abgemeldet" : null;
    if (status) { await db.update(enrollments).set({ status }).where(eq(enrollments.id, e.id)); e.status = status; n++; }
  }
  return n;
}

async function lastMail(enrollmentId: number) {
  const [m] = await db.select().from(sequenceMails).where(eq(sequenceMails.enrollmentId, enrollmentId)).orderBy(desc(sequenceMails.sentAt)).limit(1);
  return m;
}

/* Replies pause the person; repliedAt is also where the next check starts after someone chose to continue */
async function inbox(s: Seq, active: Enr[], now: Date) {
  const sender = s.config.senderId;
  let replies = 0, bounces = 0;
  if (!sender) return { replies, bounces };
  for (const e of active.filter(e => e.lastSentAt && now.getTime() - e.lastSentAt.getTime() < 30 * DAY)) {
    const since = e.repliedAt && e.repliedAt > e.startedAt ? e.repliedAt : e.startedAt;
    if (await hasReply(s.tenantId, sender, e.email, since).catch(() => null)) {
      await db.update(enrollments).set({ status: "antwort", repliedAt: now }).where(eq(enrollments.id, e.id));
      const m = await lastMail(e.id);
      if (m && !m.repliedAt) await db.update(sequenceMails).set({ repliedAt: now }).where(eq(sequenceMails.id, m.id));
      e.status = "antwort"; replies++;
      continue;
    }
    if (now.getTime() - e.lastSentAt!.getTime() < 3 * DAY && await hasBounce(s.tenantId, sender, e.email, e.lastSentAt!).catch(() => null)) {
      await db.update(enrollments).set({ status: "unzustellbar" }).where(eq(enrollments.id, e.id));
      const m = await lastMail(e.id);
      if (m) await db.update(sequenceMails).set({ bouncedAt: now }).where(eq(sequenceMails.id, m.id));
      e.status = "unzustellbar"; bounces++;
    }
  }
  return { replies, bounces };
}

async function send(s: Seq, active: Enr[], now: Date) {
  const sender = s.config.senderId;
  if (!sender) throw new Error("Kein Absender gewählt");
  const due = active.filter(e => e.status === "aktiv" && e.step < s.steps.length && e.startedAt.getTime() + s.steps[e.step].day * DAY <= now.getTime()
    && (!e.lastSentAt || now.getTime() - e.lastSentAt.getTime() >= GAP));
  if (!due.length) return { sent: 0, failed: 0, error: "" };
  const tpls = await db.select().from(sequenceTemplates).where(and(eq(sequenceTemplates.sequenceId, s.id), eq(sequenceTemplates.active, true))).orderBy(asc(sequenceTemplates.key));
  const stats = await stepStats(s.id);
  const name = await senderName(sender);
  let sent = 0, failed = 0, error = "";
  for (const e of due.slice(0, 200)) {
    const opts = tpls.filter(x => x.step === e.step);
    const k = thompson(Object.fromEntries(opts.map(x => [x.key, stats(e.step, x.key)])));
    const tpl = opts.find(x => x.key === k);
    if (!tpl) { failed++; error = `Keine aktive Variante für Mail ${e.step + 1}`; continue; }
    const subject = fill(tpl.subject, personOf(e), tpl, name), body = fill(tpl.body, personOf(e), tpl, name);
    try {
      await sendAs(s.tenantId, sender, { to: e.email, subject, text: body + footer(e.id) });
    } catch (x) { failed++; error = (x as Error).message; continue; }
    await db.insert(sequenceMails).values({ sequenceId: s.id, enrollmentId: e.id, step: e.step, variant: tpl.key, subject, body, senderId: sender, sentAt: now });
    await db.update(enrollments).set({ step: e.step + 1, lastSentAt: now }).where(eq(enrollments.id, e.id));
    sent++;
  }
  return { sent, failed, error };
}

/* Hourly: take in new registrations, drop those who left, notice replies, send what is due */
export async function runSequence(s: Seq, { now = new Date(), anyHour = false } = {}) {
  const token = await hubspotToken(s.tenantId);
  if (!token) throw new Error("HubSpot ist nicht verbunden");
  if (!s.config.enter.property) throw new Error("Keine HubSpot-Eigenschaft für die Registrierung festgelegt");
  const added = await enroll(s, token);
  const open = await db.select().from(enrollments).where(and(eq(enrollments.sequenceId, s.id), inArray(enrollments.status, OPEN)));
  const left = open.length ? await exits(s, token, open) : 0;
  const active = open.filter(e => e.status === "aktiv");
  const { replies, bounces } = await inbox(s, active, now);
  const h = berlinHour(now);
  const r = anyHour || (h >= HOURS[0] && h < HOURS[1]) ? await send(s, active, now) : { sent: 0, failed: 0, error: "" };
  const info = [added && `${added} neu`, `${r.sent} gesendet`, r.failed && `${r.failed} fehlgeschlagen (${r.error})`, replies && `${replies} Antworten`, bounces && `${bounces} unzustellbar`, left && `${left} ausgestiegen`].filter(Boolean).join(", ");
  return { ok: !r.failed, info };
}

export async function runSequences(t: Tenant, opts: { anyHour?: boolean } = {}) {
  const list = await db.select().from(sequences).where(and(eq(sequences.tenantId, t.id), eq(sequences.active, true)));
  const out: { id: number; ok: boolean; info: string }[] = [];
  for (const s of list) {
    let r: { ok: boolean; info: string };
    try { r = await runSequence(s, opts); } catch (e) { r = { ok: false, info: (e as Error).message }; }
    await log(t.id, r.ok, `${s.name}: ${r.info}`);
    out.push({ id: s.id, ...r });
  }
  return out;
}

/* Jev's view of one variant, rendered for a real person in the sequence if there is one */
export async function scoreVariant(t: Tenant, s: Seq, tplId: number) {
  const key = await jevKey(t.id);
  if (!key) throw new Error("OpenRouter ist nicht verbunden (für Jev)");
  const [tpl] = await db.select().from(sequenceTemplates).where(and(eq(sequenceTemplates.id, tplId), eq(sequenceTemplates.sequenceId, s.id)));
  if (!tpl) throw new Error("Variante nicht gefunden");
  const [e] = await db.select().from(enrollments).where(eq(enrollments.sequenceId, s.id)).orderBy(desc(enrollments.id)).limit(1);
  const p = e ? personOf(e) : SAMPLE, name = await senderName(s.config.senderId);
  const score = await scoreMail(key, { subject: fill(tpl.subject, p, tpl, name), body: fill(tpl.body, p, tpl, name), company: p.company });
  await db.update(sequenceTemplates).set({ score }).where(eq(sequenceTemplates.id, tpl.id));
  return score;
}

const nextKey = (taken: string[]) => Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)).find(k => !taken.includes(k));

/* A new variant for one step, written by the AI against the others' numbers. Starts paused, so nothing goes out unread. */
export const proposeVariant = (t: Tenant, s: Seq, step: number) => track({ tenantId: t.id, kind: "strecke", ref: `seq:${s.id}` }, async m => {
  const r = await propose(t, s, step);
  m.count(1);
  return r;
});

async function propose(t: Tenant, s: Seq, step: number) {
  const ai = await aiFor(t.id);
  if (!ai) throw new AiMissing();
  const all = await db.select().from(sequenceTemplates).where(and(eq(sequenceTemplates.sequenceId, s.id), eq(sequenceTemplates.step, step))).orderBy(asc(sequenceTemplates.key));
  const key = nextKey(all.map(x => x.key));
  if (!key) throw new Error("Zu viele Varianten");
  const stats = await stepStats(s.id), st = s.steps[step], trial = s.config.trialDays;
  const phase = st.day < trial ? `Tag ${st.day} der ${trial}-tägigen Pro-Testphase` : `${st.day - trial} Tage nach Ende der ${trial}-tägigen Pro-Testphase`;
  const text = await ask({
    key: ai, effort: "high",
    system: "Du schreibst kurze, persönliche deutsche Mails an Menschen, die sich für ein Software-Produkt registriert haben. Klingt wie von einem Menschen geschrieben, nicht wie Marketing.",
    prompt: `Produkt: ${t.name} (${t.domain})

Mail ${step + 1} von ${s.steps.length} („${st.name}“), ${phase}. Ziel jeder Mail: eine Antwort bekommen. Später verkauft ein Mensch das Pro-Abo.

Bisherige Varianten mit Ergebnissen:
${all.map(x => { const r = stats(step, x.key); return `[${x.key}] gesendet ${r.sent}, Antworten ${r.replies}${x.score ? `, Jev-Antwortchance ${x.score.reply} von 4, Schwäche ${x.score.weakness}` : ""}\nBetreff: ${x.subject}\n${x.body}`; }).join("\n\n")}

Regeln: unter 90 Wörtern, Betreff unter 35 Zeichen, genau eine Frage am Ende, die sich in einem Satz beantworten lässt. Keine Floskeln, keine Ausrufezeichen, keine Superlative.
Platzhalter: {{anrede}} (fertige Grußzeile mit Komma) und {{absender}} sind Pflicht, erlaubt sind außerdem {{vorname}}, {{nachname}}, {{firma}}. Behalte die Ansprache „${all[0]?.tone || "sie"}“.
Schreibe eine Variante, die sich in einem klaren Punkt von den bisherigen unterscheidet. Antworte nur mit \`\`\`json {"subject":"…","body":"…"}\`\`\`.`,
  });
  const out = json(text, z.object({ subject: z.string().min(3), body: z.string().min(20) }));
  const unknown = [...`${out.subject} ${out.body}`.matchAll(/{{[a-z]+}}/g)].map(m => m[0]).filter(p => !PLACEHOLDERS.includes(p));
  if (unknown.length || !out.body.includes("{{anrede}}")) throw new Error("Vorschlag der KI war unbrauchbar, bitte noch einmal versuchen");
  const [row] = await db.insert(sequenceTemplates).values({ sequenceId: s.id, step, key, tone: all[0]?.tone || "sie", subject: out.subject, body: out.body, active: false }).returning();
  await scoreVariant(t, s, row.id).catch(() => null);
  return row;
}
