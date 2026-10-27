import { and, eq, or, sql } from "drizzle-orm";
import { db, enrollments, leads, mailContacts, messages, sequenceMails, sequences, users } from "@/db";
import { HttpError, assertMember, body, checkEmail, idOf, route } from "@/lib/api";
import { attachCompanies } from "@/lib/companies";
import { cleanLead } from "@/lib/lead-fields";
import { setLeadStatus } from "@/lib/outreach";

type Ctx = { params: Promise<{ id: string }> };
const OK = ["neu", "freigabe", "angeschrieben", "beantwortet", "unzustellbar", "dublette", "kontakt", "papierkorb"];

type Act = { at: string; kind: string; title: string; text?: string; by?: string; meta?: string; src?: string; co?: boolean };

/* Everything the portal knows happened with this person, newest first: outreach mails, replies, bounces, sequence mails and mailbox traffic.
   What HubSpot logged comes from ./crm, so the dialog does not wait for HubSpot */
export const GET = route<Ctx>(async (_req, { params }, me) => {
  const [l] = await db.select().from(leads).where(eq(leads.id, await idOf(params, "Lead")));
  if (!l) throw new HttpError(404, "Lead nicht gefunden");
  await assertMember(me, l.tenantId, "Lead");
  const out: Act[] = [];
  const [ms, sm, mc] = await Promise.all([
    db.select({ m: messages, by: users.name }).from(messages).leftJoin(users, eq(users.id, messages.senderId))
      .where(and(eq(messages.tenantId, l.tenantId), or(eq(messages.leadId, l.id), sql`${messages.leadIds} @> ${JSON.stringify([l.id])}::jsonb`))),
    l.email ? db.select({ s: sequenceMails, seq: sequences.name, by: users.name }).from(sequenceMails)
      .innerJoin(enrollments, eq(enrollments.id, sequenceMails.enrollmentId)).innerJoin(sequences, eq(sequences.id, sequenceMails.sequenceId)).leftJoin(users, eq(users.id, sequenceMails.senderId))
      .where(and(eq(sequences.tenantId, l.tenantId), sql`lower(${enrollments.email}) = ${l.email.toLowerCase()}`)) : [],
    db.select({ c: mailContacts, by: users.name }).from(mailContacts).leftJoin(users, eq(users.id, mailContacts.userId))
      .where(and(eq(mailContacts.tenantId, l.tenantId), l.email ? or(eq(mailContacts.leadId, l.id), sql`lower(${mailContacts.email}) = ${l.email.toLowerCase()}`) : eq(mailContacts.leadId, l.id))),
  ]);
  for (const { m, by } of ms) {
    const subject = m.finalSubject || m.subject || "", text = m.finalBody || m.body || "";
    if (m.sentAt) out.push({ at: m.sentAt.toISOString(), kind: m.channel === "linkedin" ? "linkedin" : "sent", title: m.channel === "linkedin" ? "LinkedIn-Nachricht" : subject || "E-Mail gesendet", text, by: by || undefined });
    else if (["entwurf", "freigegeben"].includes(m.status)) out.push({ at: m.createdAt.toISOString(), kind: "draft", title: m.status === "entwurf" ? "Entwurf in Freigabe" : "Freigegeben, geht morgen raus", text: subject });
    if (m.repliedAt) out.push({ at: m.repliedAt.toISOString(), kind: "reply", title: "Antwort erhalten" });
    if (m.bouncedAt) out.push({ at: m.bouncedAt.toISOString(), kind: "bounce", title: "Unzustellbar", text: m.error || undefined });
  }
  for (const { s, seq, by } of sm) {
    out.push({ at: s.sentAt.toISOString(), kind: "sent", title: s.subject, text: s.body, by: by ? `${by}, ${seq}` : seq });
    if (s.repliedAt) out.push({ at: s.repliedAt.toISOString(), kind: "reply", title: "Antwort erhalten", by: seq });
    if (s.bouncedAt) out.push({ at: s.bouncedAt.toISOString(), kind: "bounce", title: "Unzustellbar", by: seq });
  }
  /* the mailbox scan only keeps counts and dates, so it shows as one entry per mailbox */
  for (const { c, by } of mc) if (c.lastAt) {
    const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
    out.push({ at: c.lastAt.toISOString(), kind: "mailbox", title: `${n(c.sent, "Mail", "Mails")} gesendet, ${n(c.received, "Mail", "Mails")} erhalten`,
      text: c.firstAt ? `Seit ${c.firstAt.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" })}` : undefined, by: by || undefined });
  }
  if (l.crmAt) out.push({ at: l.crmAt.toISOString(), kind: "crm", title: "Auf der Website registriert", text: l.stage ? `Lifecycle in HubSpot: ${l.stage}` : undefined });
  out.push({ at: l.createdAt.toISOString(), kind: "created", title: l.source === "Postfach" ? "Aus dem Postfach übernommen" : l.source === "HubSpot" ? "Aus HubSpot übernommen" : `Angelegt, Quelle ${l.source}` });
  /* research is left out of the list, so the dialog gets it here */
  return { items: out.sort((a, b) => b.at.localeCompare(a.at)), research: l.research };
});

/* Status change and/or edited fields; a new company name moves the contact to that company */
export const PATCH = route<Ctx>(async (req, { params }, me) => {
  const id = await idOf(params, "Lead"), b = await body(req);
  const [l] = await db.select().from(leads).where(eq(leads.id, id));
  if (!l) throw new HttpError(404, "Lead nicht gefunden");
  await assertMember(me, l.tenantId, "Lead");
  const v = cleanLead(b);
  if (v.company === "") throw new HttpError(400, "Firma fehlt");
  if (v.email !== undefined && v.email.toLowerCase() !== l.email.toLowerCase()) await checkEmail(l.tenantId, v.email, id);
  if (Object.keys(v).length) {
    const moved = v.company !== undefined && v.company !== l.company;
    await db.update(leads).set({ ...v, ...(moved ? { companyId: null } : {}) }).where(eq(leads.id, id));
    if (moved) await attachCompanies(l.tenantId);
  }
  if (Array.isArray(b.tenders)) {
    const tenders = (b.tenders as { t?: unknown; s?: unknown; f?: unknown }[]).map(x => ({ t: String(x.t ?? "").slice(0, 300), s: String(x.s ?? "").slice(0, 200), f: String(x.f ?? "").slice(0, 20) })).filter(x => x.t).slice(0, 10);
    await db.update(leads).set({ tenders }).where(eq(leads.id, id));
  }
  if (b.channel !== undefined) {
    if (!["", "mail", "linkedin"].includes(b.channel as string)) throw new HttpError(400, "Unbekannter Kanal");
    await db.update(leads).set({ channel: b.channel as string }).where(eq(leads.id, id));
  }
  if (b.vote !== undefined) {
    if (![-1, 0, 1].includes(b.vote as number)) throw new HttpError(400, "Ungültige Bewertung");
    await db.update(leads).set({ vote: b.vote as number }).where(eq(leads.id, id));
  }
  if (b.status !== undefined && b.status !== l.status) {
    if (typeof b.status !== "string" || !OK.includes(b.status)) throw new HttpError(400, "Unbekannter Status");
    await setLeadStatus(l.tenantId, id, b.status);
  }
});

export const DELETE = route<Ctx>(async (_req, { params }, me) => {
  const [l] = await db.select().from(leads).where(eq(leads.id, await idOf(params, "Lead")));
  if (!l) throw new HttpError(404, "Lead nicht gefunden");
  await assertMember(me, l.tenantId, "Lead");
  await db.delete(leads).where(eq(leads.id, l.id));
});
