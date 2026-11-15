import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNotNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { db, leads, liActions, liCampaigns, liEnrollments, liSenders, members, tenants, type LiLimits, type LiStep } from "@/db";
import { HttpError } from "./api";
import { takeOffMail } from "./sendpilot";
import { blockedOf, blockedWhy, linkedinKey, suppress } from "./suppress";

/* LinkedIn outreach without a provider. The portal decides who is written to, what and when; the local worker (bridge/linkedin.mjs)
   asks for one action at a time (claim), does it in the owner's browser and reports back (report).
   Never twice: a person (LinkedIn handle) enters at most one campaign ever (li_enrollments_handle), a send step can be handed out
   only once (li_actions_once), and an action without an answer counts as possibly sent (unklar) until a check on LinkedIn settles it. */

export type Sender = typeof liSenders.$inferSelect;
export type Campaign = typeof liCampaigns.$inferSelect;
export type Enrollment = typeof liEnrollments.$inferSelect;

/* careful defaults for one personal account; LinkedIn allows roughly 100 invites a week */
export const DEFAULT_LIMITS: LiLimits = { invites: 15, weekInvites: 80, messages: 25, checks: 40, days: [1, 2, 3, 4, 5], from: 9, to: 18, gapMin: 3, gapMax: 8, noteMax: 200 };
export const limitsOf = (s: Pick<Sender, "limits">): LiLimits => ({ ...DEFAULT_LIMITS, ...s.limits });

/* an action without an answer after this long is treated as possibly done */
export const STALE_MIN = 15;
const DAY = 86_400_000;
const CHECK_EVERY = 2 * DAY, INVITE_OPEN_DAYS = 30, REPLY_WAIT_DAYS = 14, MAX_FAILURES = 3;

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/* creates the sender for a user or gives it a new token; the token is shown once and only its hash is kept */
export async function issueSender(userId: number) {
  const token = `li_${randomBytes(24).toString("base64url")}`;
  const [s] = await db.insert(liSenders).values({ userId, tokenHash: hashToken(token) })
    .onConflictDoUpdate({ target: liSenders.userId, set: { tokenHash: hashToken(token) } }).returning();
  return { sender: s, token };
}

export async function senderByToken(auth: string | null) {
  const token = /^Bearer\s+(\S+)$/i.exec(auth || "")?.[1];
  if (!token) return null;
  const [s] = await db.select().from(liSenders).where(eq(liSenders.tokenHash, hashToken(token)));
  return s ?? null;
}

export async function senderOf(userId: number) {
  const [s] = await db.select().from(liSenders).where(eq(liSenders.userId, userId));
  if (!s) throw new HttpError(400, "Noch kein LinkedIn-Worker eingerichtet: im Portal-Ordner `npx tsx scripts/li-sender.ts <deine E-Mail>` ausführen und den Worker starten (bridge/LINKEDIN.md)");
  return s;
}

/* ---------- texts ---------- */

export const LI_PLACEHOLDERS = ["vorname", "nachname", "firma", "position", "aufhaenger"] as const;
type Person = { first: string; last: string; company: string; role: string; hook: string };
const VALUE: Record<(typeof LI_PLACEHOLDERS)[number], (p: Person) => string> =
  { vorname: p => p.first, nachname: p => p.last, firma: p => p.company, position: p => p.role, aufhaenger: p => p.hook };

export function unknownPlaceholders(text: string) {
  return [...text.matchAll(/{{\s*([^}]*?)\s*}}/g)].map(m => m[1]).filter(k => !(LI_PLACEHOLDERS as readonly string[]).includes(k));
}

/* fills the placeholders; a placeholder without a value is reported, not left empty */
export function renderText(text: string, p: Person) {
  const missing: string[] = [];
  const out = text.replace(/{{\s*([a-z]+)\s*}}/g, (_, k: (typeof LI_PLACEHOLDERS)[number]) => {
    const v = (VALUE[k]?.(p) || "").trim();
    if (!v) missing.push(k);
    return v;
  });
  return { text: out.replace(/[ \t]+\n/g, "\n").trim(), missing };
}

/* ---------- campaigns ---------- */

export type StepInput = { note: string; followups: { afterDays: number; text: string }[] };

export function stepsOf(input: StepInput, noteMax: number): LiStep[] {
  const note = input.note.trim();
  if (note.length > noteMax) throw new HttpError(400, `Die Notiz hat ${note.length} Zeichen, LinkedIn erlaubt hier ${noteMax}`);
  const steps: LiStep[] = [{ kind: "anfrage", note }, ...input.followups.map(f => ({ kind: "nachricht" as const, text: f.text.trim(), afterDays: f.afterDays }))];
  for (const s of steps) {
    const t = s.kind === "anfrage" ? s.note : s.text;
    const bad = unknownPlaceholders(t);
    if (bad.length) throw new HttpError(400, `Unbekannter Platzhalter {{${bad[0]}}}; erlaubt: ${LI_PLACEHOLDERS.map(p => `{{${p}}}`).join(", ")}`);
    if (s.kind === "nachricht" && !t) throw new HttpError(400, "Eine Folgenachricht ist leer");
  }
  return steps;
}

export async function campaignOf(userId: number, id: number) {
  const [row] = await db.select({ c: liCampaigns }).from(liCampaigns)
    .innerJoin(members, and(eq(members.tenantId, liCampaigns.tenantId), eq(members.userId, userId))).where(eq(liCampaigns.id, id));
  if (!row) throw new HttpError(404, "Kampagne nicht gefunden");
  return row.c;
}

export async function saveCampaign(userId: number, tenantId: number, input: { id?: number; name: string; noteFallback?: "pausieren" | "ohne_notiz" } & StepInput) {
  const sender = await senderOf(userId);
  const steps = stepsOf(input, limitsOf(sender).noteMax);
  if (input.id) {
    const c = await campaignOf(userId, input.id);
    if (c.tenantId !== tenantId) throw new HttpError(400, "Die Kampagne gehört zu einem anderen Mandanten");
    if (c.status === "beendet") throw new HttpError(400, "Die Kampagne ist beendet");
    /* steps already done by someone keep their place; only texts and later steps change, so nobody gets a step twice */
    const [u] = await db.update(liCampaigns).set({ name: input.name, steps, noteFallback: input.noteFallback ?? c.noteFallback, updatedAt: new Date() })
      .where(eq(liCampaigns.id, c.id)).returning();
    return u;
  }
  const [c] = await db.insert(liCampaigns).values({ tenantId, senderId: sender.id, name: input.name, steps, noteFallback: input.noteFallback ?? "pausieren", createdBy: userId }).returning();
  return c;
}

export async function setCampaignStatus(userId: number, id: number, status: "aktiv" | "pausiert" | "beendet") {
  const c = await campaignOf(userId, id);
  if (c.status === "beendet") throw new HttpError(400, "Die Kampagne ist schon beendet");
  await db.update(liCampaigns).set({ status, updatedAt: new Date() }).where(eq(liCampaigns.id, id));
  /* a finished campaign lets go of its waiting people; they stay enrolled, so they are not written to by another campaign either */
  if (status === "beendet") await db.update(liEnrollments).set({ state: "abgebrochen", note: "Kampagne beendet", updatedAt: new Date() })
    .where(and(eq(liEnrollments.campaignId, id), inArray(liEnrollments.state, ["wartet", "pruefen"])));
  return { id, status };
}

const STATES = ["wartet", "angefragt", "vernetzt", "beantwortet", "fertig", "abgebrochen", "fehler", "pruefen"] as const;

export async function listCampaigns(userId: number, tenantId?: number) {
  const rows = await db.select({ c: liCampaigns, tenant: tenants.slug }).from(liCampaigns)
    .innerJoin(members, and(eq(members.tenantId, liCampaigns.tenantId), eq(members.userId, userId))).innerJoin(tenants, eq(tenants.id, liCampaigns.tenantId))
    .where(tenantId ? eq(liCampaigns.tenantId, tenantId) : undefined).orderBy(desc(liCampaigns.id));
  if (!rows.length) return [];
  const counts = await db.select({ id: liEnrollments.campaignId, state: liEnrollments.state, n: count() }).from(liEnrollments)
    .where(inArray(liEnrollments.campaignId, rows.map(r => r.c.id))).groupBy(liEnrollments.campaignId, liEnrollments.state);
  return rows.map(({ c, tenant }) => {
    const by = Object.fromEntries(counts.filter(x => x.id === c.id).map(x => [x.state, x.n]));
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    const invited = total - (by.wartet || 0) - (by.abgebrochen || 0) - (by.fehler || 0);
    return { id: c.id, tenant, name: c.name, status: c.status, noteFallback: c.noteFallback, steps: c.steps, people: total, states: by,
      acceptRate: invited ? Math.round(100 * ((by.vernetzt || 0) + (by.beantwortet || 0)) / invited) : null,
      replyRate: invited ? Math.round(100 * (by.beantwortet || 0) / invited) : null };
  });
}

/* ---------- enrolling: the guard against writing to someone twice ---------- */

type Skip = { leadId: number; name: string; reason: string };

export async function enroll(userId: number, campaignId: number, leadIds: number[], opt: { confirm: boolean; allowMailed?: boolean }) {
  const c = await campaignOf(userId, campaignId);
  if (c.status === "beendet") throw new HttpError(400, "Die Kampagne ist beendet");
  const sender = await senderOf(userId), lim = limitsOf(sender);
  const rows = await db.select().from(leads).where(and(eq(leads.tenantId, c.tenantId), inArray(leads.id, leadIds)));
  const blocked = await blockedOf(c.tenantId);

  /* everyone already reached on LinkedIn from any tenant this user works in (SendPilot/Sendler or a campaign), or mailed, or a known contact */
  const mine = db.select({ id: members.tenantId }).from(members).where(eq(members.userId, userId));
  const others = await db.select({ id: leads.id, linkedin: leads.linkedin, status: leads.status, sendpilotAt: leads.sendpilotAt, crmAt: leads.crmAt }).from(leads)
    .where(and(inArray(leads.tenantId, mine), ne(leads.linkedin, ""),
      or(isNotNull(leads.sendpilotAt), isNotNull(leads.crmAt), inArray(leads.status, ["angeschrieben", "beantwortet", "kontakt", "freigabe"]))));
  const known = new Map<string, string>();
  for (const o of others) {
    const h = linkedinKey(o.linkedin);
    if (!h || leadIds.includes(o.id)) continue;
    const why = o.sendpilotAt ? "schon über LinkedIn angeschrieben (anderer Lead)" : o.crmAt ? "registriert (anderer Lead)"
      : o.status === "kontakt" ? "bestehender Kontakt (anderer Lead)" : o.status === "beantwortet" ? "hat schon geantwortet (anderer Lead)"
      : opt.allowMailed ? "" : `schon per Mail ${o.status === "freigabe" ? "geplant" : "angeschrieben"} (anderer Lead)`;
    if (why && !known.has(h)) known.set(h, why);
  }
  const handles = rows.map(r => linkedinKey(r.linkedin)).filter(Boolean);
  const taken = new Map((handles.length ? await db.select({ handle: liEnrollments.handle, campaignId: liEnrollments.campaignId }).from(liEnrollments)
    .where(inArray(liEnrollments.handle, handles)) : []).map(e => [e.handle, e.campaignId]));

  const add: { lead: typeof rows[number]; handle: string; texts: string[] }[] = [], skipped: Skip[] = [], seen = new Set<string>();
  for (const id of leadIds) if (!rows.some(r => r.id === id)) skipped.push({ leadId: id, name: "", reason: "nicht in diesem Mandanten" });
  for (const l of rows) {
    const name = [l.first, l.last].filter(Boolean).join(" ") || l.company, handle = linkedinKey(l.linkedin);
    const why = !handle ? "kein LinkedIn-Profil"
      : seen.has(handle) ? "dasselbe Profil steht doppelt in der Auswahl"
      : taken.has(handle) ? `schon in Kampagne ${taken.get(handle)}`
      : l.sendpilotAt ? "schon über LinkedIn angeschrieben (SendPilot/Sendler oder Kampagne)"
      : ["papierkorb", "dublette", "unzustellbar"].includes(l.status) ? `Status ${l.status}`
      : l.status === "kontakt" ? "bestehender Kontakt, wird nie kalt angeschrieben"
      : l.status === "beantwortet" ? "hat schon geantwortet"
      : !opt.allowMailed && ["angeschrieben", "freigabe"].includes(l.status) ? `schon per Mail ${l.status === "freigabe" ? "geplant" : "angeschrieben"}`
      : l.crmAt ? "auf der Website registriert"
      : blockedWhy(blocked, l) || known.get(handle) || "";
    if (why) { skipped.push({ leadId: l.id, name, reason: why }); continue; }
    seen.add(handle);
    const person = { first: l.first, last: l.last, company: l.company, role: l.role, hook: l.hook };
    const parts = c.steps.map(s => renderText(s.kind === "anfrage" ? s.note : s.text, person));
    const missing = [...new Set(parts.flatMap(p => p.missing))];
    if (missing.length) { skipped.push({ leadId: l.id, name, reason: `Platzhalter ohne Wert: ${missing.map(m => `{{${m}}}`).join(", ")}` }); continue; }
    if (parts[0].text.length > lim.noteMax) { skipped.push({ leadId: l.id, name, reason: `Notiz ${parts[0].text.length} Zeichen, erlaubt ${lim.noteMax}` }); continue; }
    add.push({ lead: l, handle, texts: parts.map(p => p.text) });
  }

  const preview = add.map(a => ({ leadId: a.lead.id, name: [a.lead.first, a.lead.last].filter(Boolean).join(" "), company: a.lead.company, handle: a.handle }));
  if (!opt.confirm) return { confirmed: false, campaign: c.name, wouldAdd: preview.length, skipped, sample: add.slice(0, 3).map(a => ({ name: `${a.lead.first} ${a.lead.last}`.trim(), texts: a.texts })), people: preview };
  if (!add.length) return { confirmed: true, added: 0, skipped };

  const ins = await db.insert(liEnrollments).values(add.map(a => ({ handle: a.handle, campaignId: c.id, tenantId: c.tenantId, senderId: c.senderId, leadId: a.lead.id,
    name: [a.lead.first, a.lead.last].filter(Boolean).join(" "), company: a.lead.company, texts: a.texts }))).onConflictDoNothing().returning({ leadId: liEnrollments.leadId });
  const got = new Set(ins.map(i => i.leadId));
  /* lost a race with another enrollment of the same profile */
  for (const a of add) if (!got.has(a.lead.id)) skipped.push({ leadId: a.lead.id, name: `${a.lead.first} ${a.lead.last}`.trim(), reason: "gerade in eine andere Kampagne aufgenommen" });
  await takeOffMail(c.tenantId, [...got].filter((x): x is number => x != null));
  return { confirmed: true, added: ins.length, skipped, campaignStatus: c.status };
}

export async function stopPeople(userId: number, ids: number[], opt: { block?: boolean; note?: string }) {
  const rows = await db.select({ e: liEnrollments }).from(liEnrollments)
    .innerJoin(members, and(eq(members.tenantId, liEnrollments.tenantId), eq(members.userId, userId))).where(inArray(liEnrollments.id, ids));
  const stoppable = rows.filter(r => !["beantwortet", "fertig", "abgebrochen"].includes(r.e.state)).map(r => r.e.id);
  if (stoppable.length) await db.update(liEnrollments).set({ state: "abgebrochen", note: opt.note || "von Hand gestoppt", updatedAt: new Date() }).where(inArray(liEnrollments.id, stoppable));
  if (opt.block) for (const r of rows) await suppress(r.e.tenantId, [{ kind: "linkedin", value: r.e.handle }], "manuell", { note: opt.note || "LinkedIn-Kampagne", userId });
  return { stopped: stoppable.length, unchanged: rows.length - stoppable.length, notFound: ids.length - rows.length };
}

export async function listPeople(userId: number, f: { campaignId?: number; state?: string; limit: number; offset: number }) {
  const where = and(f.campaignId ? eq(liEnrollments.campaignId, f.campaignId) : undefined, f.state ? eq(liEnrollments.state, f.state) : undefined);
  const rows = await db.select({ e: liEnrollments }).from(liEnrollments)
    .innerJoin(members, and(eq(members.tenantId, liEnrollments.tenantId), eq(members.userId, userId))).where(where)
    .orderBy(desc(liEnrollments.updatedAt)).limit(f.limit).offset(f.offset);
  const ids = rows.map(r => r.e.id);
  const acts = ids.length ? await db.select().from(liActions).where(inArray(liActions.enrollmentId, ids)).orderBy(asc(liActions.id)) : [];
  return rows.map(({ e }) => ({ id: e.id, campaignId: e.campaignId, leadId: e.leadId, name: e.name, company: e.company, profile: `https://www.linkedin.com/in/${e.handle}/`,
    state: e.state, step: e.step, nextAt: e.state === "wartet" || e.state === "vernetzt" ? e.nextAt : null, invitedAt: e.invitedAt, connectedAt: e.connectedAt,
    lastMessageAt: e.lastMessageAt, repliedAt: e.repliedAt, reply_untrusted: e.reply || undefined, note: e.note || undefined,
    history: acts.filter(a => a.enrollmentId === e.id).map(a => ({ at: a.doneAt ?? a.claimedAt, kind: a.kind, step: a.step, status: a.status, outcome: a.outcome, detail: a.detail || undefined })) }));
}

/* ---------- the worker side ---------- */

const berlin = (d: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { dow: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday) + 1, hour: Number(p.hour) + Number(p.minute) / 60 };
};
export const inWindow = (lim: LiLimits, d: Date) => { const b = berlin(d); return lim.days.includes(b.dow) && b.hour >= lim.from && b.hour < lim.to; };
/* the pause after an action, the same for the same action so a repeated claim does not roll again */
export const gapAfter = (lim: LiLimits, actionId: number) => (lim.gapMin + ((actionId * 7919) % 1000) / 1000 * Math.max(0, lim.gapMax - lim.gapMin)) * 60_000;
const firstOfNextMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 6));

export type WorkerAction = { id: number; kind: "anfrage" | "nachricht" | "pruefen"; profile: string; handle: string; name: string;
  text: string; withNote: boolean; fallback: "pausieren" | "ohne_notiz"; noteMax: number; settle?: { kind: "anfrage" | "nachricht"; text: string } };
export type Claim = { action: WorkerAction } | { wait: number; reason: string };

async function counts(senderId: number, now: Date) {
  const dayStart = sql`(date_trunc('day', ${now.toISOString()}::timestamptz at time zone 'Europe/Berlin') at time zone 'Europe/Berlin')`;
  const sent = inArray(liActions.status, ["laeuft", "erledigt", "unklar"]);
  const [r] = await db.select({
    invites: sql<number>`count(*) filter (where ${liActions.kind} = 'anfrage' and ${sent} and ${liActions.claimedAt} >= ${dayStart})::int`,
    week: sql<number>`count(*) filter (where ${liActions.kind} = 'anfrage' and ${sent} and ${liActions.claimedAt} >= ${new Date(now.getTime() - 7 * DAY).toISOString()}::timestamptz)::int`,
    messages: sql<number>`count(*) filter (where ${liActions.kind} = 'nachricht' and ${sent} and ${liActions.claimedAt} >= ${dayStart})::int`,
    checks: sql<number>`count(*) filter (where ${liActions.kind} = 'pruefen' and ${liActions.claimedAt} >= ${dayStart})::int`,
  }).from(liActions).where(eq(liActions.senderId, senderId));
  return r;
}

/* Hands out the next action, or how long to wait. Order: settle what may have been sent, follow-up messages, invites, checks. */
/* start of the pause reason the worker sets when LinkedIn ended its session; the claim route lifts exactly this pause again */
export const LOGIN_PAUSE = "LinkedIn-Anmeldung abgelaufen";

export async function claim(sender: Sender, now = new Date()): Promise<Claim> {
  await db.update(liSenders).set({ seenAt: now }).where(eq(liSenders.id, sender.id));
  if (sender.paused) return { wait: 600, reason: `pausiert: ${sender.pauseReason || "von Hand"}` };
  const lim = limitsOf(sender);

  /* an action nobody answered for may have gone out: never handed out again, a check on LinkedIn decides */
  const stale = await db.update(liActions).set({ status: "unklar", outcome: "keine_rueckmeldung", doneAt: now })
    .where(and(eq(liActions.senderId, sender.id), eq(liActions.status, "laeuft"), lt(liActions.claimedAt, new Date(now.getTime() - STALE_MIN * 60_000))))
    .returning({ e: liActions.enrollmentId, kind: liActions.kind });
  for (const s of stale) if (s.kind !== "pruefen") await db.update(liEnrollments).set({ state: "pruefen", nextAt: now, updatedAt: now }).where(eq(liEnrollments.id, s.e));
  const [running] = await db.select({ id: liActions.id }).from(liActions).where(and(eq(liActions.senderId, sender.id), eq(liActions.status, "laeuft")));
  if (running) return { wait: 60, reason: `Aktion ${running.id} läuft noch` };

  if (!inWindow(lim, now)) return { wait: 900, reason: "außerhalb der Sendezeit" };
  const [last] = await db.select({ id: liActions.id, at: liActions.doneAt }).from(liActions).where(eq(liActions.senderId, sender.id)).orderBy(desc(liActions.id)).limit(1);
  if (last?.at) { const left = last.at.getTime() + gapAfter(lim, last.id) - now.getTime(); if (left > 0) return { wait: Math.ceil(left / 1000), reason: "Pause zwischen Aktionen" }; }

  const n = await counts(sender.id, now);
  const active = and(eq(liEnrollments.senderId, sender.id), eq(liCampaigns.status, "aktiv"));
  const base = db.select({ e: liEnrollments, c: liCampaigns }).from(liEnrollments).innerJoin(liCampaigns, eq(liCampaigns.id, liEnrollments.campaignId));
  const pick = async (where: ReturnType<typeof and>, order = asc(liEnrollments.nextAt)) => (await base.where(where).orderBy(order, asc(liEnrollments.id)).limit(1))[0];

  type Pick = { e: Enrollment; c: Campaign; kind: WorkerAction["kind"]; text: string; withNote: boolean; settle?: WorkerAction["settle"] };
  let p: Pick | undefined;

  /* 1. settle an action that may have gone out (also when its campaign was paused meanwhile) */
  if (n.checks < lim.checks) {
    const r = await pick(and(eq(liEnrollments.senderId, sender.id), eq(liEnrollments.state, "pruefen")));
    if (r) {
      const [u] = await db.select().from(liActions).where(and(eq(liActions.enrollmentId, r.e.id), eq(liActions.status, "unklar"), ne(liActions.kind, "pruefen"))).orderBy(desc(liActions.id)).limit(1);
      p = { ...r, kind: "pruefen", text: "", withNote: false, settle: u ? { kind: u.kind as "anfrage" | "nachricht", text: u.text } : undefined };
    }
  }
  /* 2. the next message to someone who accepted */
  if (!p && n.messages < lim.messages) {
    const r = await pick(and(active, eq(liEnrollments.state, "vernetzt"), lte(liEnrollments.nextAt, now), sql`${liEnrollments.step} < jsonb_array_length(${liEnrollments.texts})`));
    if (r) p = { ...r, kind: "nachricht", text: r.e.texts[r.e.step], withNote: false };
  }
  /* 3. an invite; with LinkedIn's note limit reached, campaigns that pause on it wait */
  const invitesOk = n.invites < lim.invites && n.week < lim.weekInvites && !(sender.inviteBlockedUntil && sender.inviteBlockedUntil > now);
  const notesBlocked = !!(sender.noteBlockedUntil && sender.noteBlockedUntil > now);
  if (!p && invitesOk) {
    const r = await pick(and(active, eq(liEnrollments.state, "wartet"), eq(liEnrollments.step, 0), lte(liEnrollments.nextAt, now),
      notesBlocked ? or(eq(liCampaigns.noteFallback, "ohne_notiz"), sql`${liCampaigns.steps}->0->>'note' = ''`) : undefined), asc(liEnrollments.id));
    if (r) { const note = r.e.texts[0] || ""; p = { ...r, kind: "anfrage", text: notesBlocked ? "" : note, withNote: !!note && !notesBlocked }; }
  }
  /* 4. look whether invites were accepted and messages answered */
  if (!p && n.checks < lim.checks) {
    const r = await pick(and(eq(liEnrollments.senderId, sender.id), inArray(liEnrollments.state, ["angefragt", "vernetzt"]), lte(liEnrollments.checkAt, now)), asc(liEnrollments.checkAt));
    if (r) p = { ...r, kind: "pruefen", text: "", withNote: false };
  }
  if (!p) {
    const why = !invitesOk ? "Tageslimit oder LinkedIn-Wochenlimit für Anfragen erreicht" : notesBlocked ? "LinkedIn erlaubt diesen Monat keine Notizen mehr, Kampagnen mit Notiz warten" : "nichts fällig";
    return { wait: 600, reason: why };
  }

  const [a] = await db.insert(liActions).values({ enrollmentId: p.e.id, senderId: sender.id, kind: p.kind, step: p.kind === "pruefen" ? -1 : p.e.step, text: p.text, withNote: p.withNote, claimedAt: now })
    .onConflictDoNothing().returning();
  if (!a) {
    /* this step already ran (or another claim won): never hand it out, a check decides */
    if (p.kind !== "pruefen") await db.update(liEnrollments).set({ state: "pruefen", nextAt: now, updatedAt: now }).where(eq(liEnrollments.id, p.e.id));
    return { wait: 5, reason: "Schritt schon vergeben" };
  }
  return { action: { id: a.id, kind: p.kind, profile: `https://www.linkedin.com/in/${p.e.handle}/`, handle: p.e.handle, name: p.e.name, text: p.text, withNote: p.withNote,
    fallback: p.c.noteFallback === "ohne_notiz" ? "ohne_notiz" : "pausieren", noteMax: lim.noteMax, ...(p.settle ? { settle: p.settle } : {}) } };
}

/* What the worker saw. Send outcomes: gesendet | gesendet_ohne_notiz | schon_angefragt | schon_vernetzt | notizlimit | wochenlimit | nicht_moeglich |
   beantwortet (seen before sending, nothing sent) | nicht_vernetzt | fehler (surely not sent) | unklar (maybe sent) | login.
   Checks report what the profile shows: connected, pending, replied (+ reply), and for settling whether the text is in the thread (found). */
export type Report = { outcome: string; detail?: string; connected?: boolean; pending?: boolean; replied?: boolean; reply?: string; found?: boolean };

export async function report(sender: Sender, actionId: number, r: Report, now = new Date()) {
  const [a] = await db.select().from(liActions).where(and(eq(liActions.id, actionId), eq(liActions.senderId, sender.id)));
  if (!a) throw new HttpError(404, "Aktion nicht gefunden");
  if (a.status !== "laeuft") return { ok: true, ignored: `Aktion ist schon ${a.status}` };
  const [e] = await db.select().from(liEnrollments).where(eq(liEnrollments.id, a.enrollmentId));
  const [c] = await db.select().from(liCampaigns).where(eq(liCampaigns.id, e.campaignId));
  const detail = (r.detail || "").slice(0, 500);
  const done = (status: string, outcome = r.outcome) => db.update(liActions).set({ status, outcome, detail, doneAt: now }).where(eq(liActions.id, a.id));
  const setE = (v: Partial<Enrollment>) => db.update(liEnrollments).set({ ...v, updatedAt: now }).where(eq(liEnrollments.id, e.id));
  const later = (ms: number) => new Date(now.getTime() + ms);
  const toLead = async (status: "angeschrieben" | "beantwortet") => {
    if (!e.leadId) return;
    const from = status === "angeschrieben" ? ["neu", "freigabe"] : ["neu", "freigabe", "angeschrieben"];
    await db.update(leads).set({ status, lastContactAt: now }).where(and(eq(leads.id, e.leadId), inArray(leads.status, from)));
  };
  const replied = async () => {
    await setE({ state: "beantwortet", repliedAt: now, reply: (r.reply || "").slice(0, 2000), checkAt: null });
    await toLead("beantwortet");
  };
  const failed = async (status = "fehler") => {
    await done(status);
    const f = e.failures + 1;
    await setE(f >= MAX_FAILURES ? { state: "fehler", failures: f, note: detail || r.outcome } : { failures: f, nextAt: later(60 * 60_000) });
  };
  const nextMessage = (step: number) => {
    const s = c.steps[step];
    return s?.kind === "nachricht" ? later(s.afterDays * DAY) : later(CHECK_EVERY);
  };

  if (r.outcome === "login") {
    await done("fehler");
    await db.update(liSenders).set({ paused: true, pauseReason: `${LOGIN_PAUSE}: in Chrome bei linkedin.com anmelden, der Worker meldet sich dann selbst wieder an` }).where(eq(liSenders.id, sender.id));
    return { ok: true };
  }
  if (r.outcome === "unklar") {
    await done("unklar");
    if (a.kind !== "pruefen") await setE({ state: "pruefen", nextAt: now });
    return { ok: true };
  }

  if (a.kind === "anfrage") {
    switch (r.outcome) {
      case "gesendet": case "gesendet_ohne_notiz":
        await done("erledigt");
        await setE({ state: "angefragt", step: 1, invitedAt: now, checkAt: later(DAY), failures: 0 });
        await toLead("angeschrieben");
        if (r.outcome === "gesendet_ohne_notiz" && a.withNote) await db.update(liSenders).set({ noteBlockedUntil: firstOfNextMonth(now) }).where(eq(liSenders.id, sender.id));
        break;
      case "schon_angefragt":
        await done("uebersprungen");
        await setE({ state: "angefragt", step: 1, invitedAt: e.invitedAt ?? now, checkAt: later(DAY), note: "Anfrage war schon offen" });
        break;
      case "schon_vernetzt":
        await done("uebersprungen");
        await setE({ state: "fertig", note: "war schon vernetzt, nichts gesendet" });
        break;
      case "notizlimit":
        await done("fehler");
        await db.update(liSenders).set({ noteBlockedUntil: firstOfNextMonth(now) }).where(eq(liSenders.id, sender.id));
        break;
      case "wochenlimit":
        await done("fehler");
        await db.update(liSenders).set({ inviteBlockedUntil: later(3 * DAY) }).where(eq(liSenders.id, sender.id));
        break;
      case "nicht_moeglich":
        await done("fehler");
        await setE({ state: "fehler", note: detail || "Vernetzen nicht möglich" });
        break;
      default: await failed();
    }
    return { ok: true };
  }

  if (a.kind === "nachricht") {
    switch (r.outcome) {
      case "gesendet": {
        await done("erledigt");
        const step = e.step + 1;
        await setE({ step, lastMessageAt: now, failures: 0, nextAt: nextMessage(step), checkAt: later(CHECK_EVERY) });
        break;
      }
      case "beantwortet": await done("uebersprungen"); await replied(); break;
      case "nicht_vernetzt": await done("fehler"); await setE({ state: "pruefen", nextAt: now }); break;
      default: await failed();
    }
    return { ok: true };
  }

  /* checks */
  /* a check that did not work changes nothing but its time; it never turns into a send */
  if (r.outcome !== "ok") { await done("fehler"); await setE(e.state === "pruefen" ? { nextAt: later(60 * 60_000) } : { checkAt: later(60 * 60_000) }); return { ok: true }; }
  await done("erledigt");
  if (r.replied) { await replied(); return { ok: true }; }

  if (e.state === "pruefen") {
    /* settle the action that may have gone out */
    const [u] = await db.select().from(liActions).where(and(eq(liActions.enrollmentId, e.id), eq(liActions.status, "unklar"), ne(liActions.kind, "pruefen"))).orderBy(desc(liActions.id)).limit(1);
    const sent = !u ? null : u.kind === "anfrage" ? !!(r.pending || r.connected) : !!r.found;
    if (u) await db.update(liActions).set(sent ? { status: "erledigt", outcome: "geprueft_gesendet" } : { status: "fehler", outcome: "geprueft_nicht_gesendet" }).where(eq(liActions.id, u.id));
    if (u?.kind === "anfrage") {
      if (sent) { await setE({ state: r.connected ? "vernetzt" : "angefragt", step: 1, invitedAt: u.claimedAt, connectedAt: r.connected ? now : null, nextAt: nextMessage(1), checkAt: later(CHECK_EVERY) }); await toLead("angeschrieben"); }
      else await setE({ state: "wartet", nextAt: now });
    } else if (u?.kind === "nachricht") {
      if (sent) await setE({ state: "vernetzt", step: u.step + 1, lastMessageAt: u.claimedAt, nextAt: nextMessage(u.step + 1), checkAt: later(CHECK_EVERY) });
      else await setE({ state: "vernetzt", nextAt: now });
    } else await setE({ state: e.invitedAt ? (r.connected ? "vernetzt" : "angefragt") : "wartet", nextAt: now, checkAt: e.invitedAt ? later(CHECK_EVERY) : null });
    return { ok: true };
  }

  const checks = e.checks + 1;
  if (e.state === "angefragt") {
    if (r.connected) await setE({ state: "vernetzt", connectedAt: now, checks, nextAt: nextMessage(e.step), checkAt: later(CHECK_EVERY) });
    else if (!r.pending) await setE({ state: "fertig", checks, checkAt: null, note: "Anfrage nicht mehr offen (abgelehnt oder zurückgezogen)" });
    else if (e.invitedAt && now.getTime() - e.invitedAt.getTime() > INVITE_OPEN_DAYS * DAY) await setE({ state: "fertig", checks, checkAt: null, note: `nach ${INVITE_OPEN_DAYS} Tagen nicht angenommen` });
    else await setE({ checks, checkAt: later(CHECK_EVERY) });
  } else if (e.state === "vernetzt") {
    const allSent = e.step >= e.texts.length, since = (e.lastMessageAt ?? e.connectedAt ?? now).getTime();
    if (allSent && now.getTime() - since > REPLY_WAIT_DAYS * DAY) await setE({ state: "fertig", checks, checkAt: null, note: "keine Antwort" });
    else await setE({ checks, checkAt: later(CHECK_EVERY) });
  }
  return { ok: true };
}

/* ---------- overview ---------- */

export async function liStatus(userId: number, now = new Date()) {
  const sender = await senderOf(userId), lim = limitsOf(sender), n = await counts(sender.id, now);
  const open = await db.select({ state: liEnrollments.state, n: count() }).from(liEnrollments).where(eq(liEnrollments.senderId, sender.id)).groupBy(liEnrollments.state);
  const online = !!sender.seenAt && now.getTime() - sender.seenAt.getTime() < 20 * 60_000;
  return {
    worker: { online, seenAt: sender.seenAt, info: sender.workerInfo || undefined, paused: sender.paused, pauseReason: sender.pauseReason || undefined, inWindow: inWindow(lim, now) },
    limits: lim, today: n,
    blocks: { notesUntil: sender.noteBlockedUntil && sender.noteBlockedUntil > now ? sender.noteBlockedUntil : null, invitesUntil: sender.inviteBlockedUntil && sender.inviteBlockedUntil > now ? sender.inviteBlockedUntil : null },
    people: Object.fromEntries(STATES.map(s => [s, open.find(o => o.state === s)?.n ?? 0])),
    campaigns: await listCampaigns(userId),
  };
}

export async function updateSender(userId: number, v: { paused?: boolean; limits?: Partial<LiLimits>; clearNoteBlock?: boolean; clearInviteBlock?: boolean }) {
  const s = await senderOf(userId);
  const limits = { ...s.limits, ...v.limits };
  const lim = { ...DEFAULT_LIMITS, ...limits };
  if (lim.from >= lim.to || lim.gapMin > lim.gapMax || !lim.days.length) throw new HttpError(400, "Sendezeit oder Pausen ergeben keinen Sinn");
  await db.update(liSenders).set({ limits, ...(v.paused !== undefined ? { paused: v.paused, pauseReason: v.paused ? "von Hand" : "" } : {}),
    ...(v.clearNoteBlock ? { noteBlockedUntil: null } : {}), ...(v.clearInviteBlock ? { inviteBlockedUntil: null } : {}) }).where(eq(liSenders.id, s.id));
  return liStatus(userId);
}
