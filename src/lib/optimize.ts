import { createHash } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, leads, members, messages, runs, templates, tenants, users, type MailScore, type TemplateScore } from "@/db";
import { getInteg } from "./integrations";
import { writeMails } from "./writer";
import { fill } from "./fill";
import { jevKey, scoreMail } from "./jev";
import { lint, nextKey, PLAYBOOK } from "./playbook";

type Tenant = typeof tenants.$inferSelect;
type Tpl = typeof templates.$inferSelect;
type Lead = typeof leads.$inferSelect;
type Stat = { sent: number; replies: number };

/* GEPA in small: take the best template, let Claude rewrite it against Jev's complaints,
   keep a variant only if Jev rates it clearly better, then let real replies decide (see pickVariant). */
const SAMPLE = 3, CANDIDATES = 3, MAX_ACTIVE = 4, MIN_SENT = 30, MIN_GAIN = 0.15;

const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length) * 100) / 100;
const hashOf = (t: { subject: string; body: string }, sample: Lead[]) =>
  createHash("sha1").update(`${t.subject}\n${t.body}\n${sample.map(l => l.id).join()}`).digest("hex").slice(0, 12);

async function scoreTemplate(key: string, t: { tone: string; subject: string; body: string }, sample: Lead[], sender: string): Promise<TemplateScore> {
  const out: MailScore[] = [];
  for (const l of sample) {
    out.push(await scoreMail(key, { subject: fill(t.subject, l, t, sender), body: fill(t.body, l, t, sender), company: l.company, role: l.role }));
  }
  const weaknesses: Record<string, number> = {};
  for (const s of out) weaknesses[s.weakness] = (weaknesses[s.weakness] || 0) + 1;
  return {
    reply: avg(out.map(s => s.reply)), specific: avg(out.map(s => s.specific)), easyAsk: avg(out.map(s => s.easyAsk)),
    weakness: Object.entries(weaknesses).sort((a, b) => b[1] - a[1])[0][0],
    words: avg(out.map(s => s.words)), subjectLen: avg(out.map(s => s.subjectLen)),
    hash: hashOf(t, sample), n: out.length, weaknesses,
  };
}

/* Real reply rate wins once both sides have enough sends; otherwise Jev decides */
function better(a: Tpl, b: Tpl, st: Record<string, Stat>) {
  const sa = st[a.key], sb = st[b.key];
  if (sa?.sent >= MIN_SENT && sb?.sent >= MIN_SENT) return sa.replies / sa.sent - sb.replies / sb.sent;
  return (a.score?.reply ?? 0) - (b.score?.reply ?? 0);
}

const describe = (t: Tpl, s: Stat | undefined) => `[${t.key}] „${t.name}“ (${t.tone}) – gesendet ${s?.sent ?? 0}, Antworten ${s?.replies ?? 0}
Jev: Antwortchance ${t.score?.reply ?? "?"} von 4, konkret ${t.score?.specific ?? "?"}, eine klare Bitte ${t.score?.easyAsk ?? "?"}, Schwächen ${JSON.stringify(t.score?.weaknesses ?? {})}
Betreff: ${t.subject}
${t.body}`;

export async function optimizeTemplates(t: Tenant) {
  const jev = await jevKey(t.id);
  if (!jev) throw new Error("OpenRouter ist nicht verbunden (für Jev)");

  const sample = await db.select().from(leads)
    .where(and(eq(leads.tenantId, t.id), t.tenders ? sql`jsonb_array_length(${leads.tenders}) > 0` : sql`${leads.hook} <> ''`))
    .orderBy(desc(leads.createdAt)).limit(SAMPLE);
  if (!sample.length) throw new Error("Noch keine Leads mit Anlass zum Testen");
  const [me] = await db.select({ name: users.name }).from(users).innerJoin(members, eq(members.userId, users.id)).where(eq(members.tenantId, t.id)).orderBy(asc(users.id)).limit(1);
  const sender = me?.name || "";

  let active = await db.select().from(templates).where(and(eq(templates.tenantId, t.id), eq(templates.active, true))).orderBy(asc(templates.key));
  if (!active.length) throw new Error("Keine aktive Vorlage");
  for (const tpl of active) {
    if (tpl.score?.hash === hashOf(tpl, sample)) continue;
    const score = await scoreTemplate(jev, tpl, sample, sender);
    await db.update(templates).set({ score }).where(eq(templates.id, tpl.id));
    tpl.score = score;
  }

  const rows = await db.select({ v: messages.variant, sent: sql<number>`count(${messages.sentAt}) - count(${messages.bouncedAt})`.mapWith(Number), replies: sql<number>`count(${messages.repliedAt})`.mapWith(Number) })
    .from(messages).where(eq(messages.tenantId, t.id)).groupBy(messages.variant);
  const st: Record<string, Stat> = Object.fromEntries(rows.map(r => [r.v, r]));
  active = [...active].sort((a, b) => better(b, a, st));
  const parent = active[0];

  const required = ["{{anrede}}", "{{absender}}", t.tenders ? "{{ausschreibungen}}" : "{{aufhaenger}}"];
  const brief = `${PLAYBOOK}

Angebot und Zielgruppe:
${t.settings.prompt.slice(0, 1500)}

Pflicht-Platzhalter: ${required.join(", ")}. Erlaubt außerdem: {{firma}}, {{vorname}}, {{nachname}}. {{anrede}} ergibt eine fertige Grußzeile mit Komma.
Behalte die Ansprache „${parent.tone}“ der Ausgangsvorlage.

Aktive Vorlagen mit Messwerten, beste zuerst:
${active.map(x => describe(x, st[x.key])).join("\n\n")}

Ausgangsvorlage ist [${parent.key}]. Behebe vor allem ihre häufigste Schwäche laut Jev: ${parent.score?.weakness}.`;

  const proposed = (await writeMails(t.id, brief, CANDIDATES)).filter(c => !lint(c.subject, c.body, required).length);
  let best: { c: (typeof proposed)[number]; score: TemplateScore } | null = null;
  for (const c of proposed) {
    const score = await scoreTemplate(jev, { tone: parent.tone, ...c }, sample, sender);
    if (!best || score.reply > best.score.reply) best = { c, score };
  }

  const base = parent.score?.reply ?? 0;
  if (!best || best.score.reply < base + MIN_GAIN) {
    const info = `Keine Variante besser als ${parent.key} (Jev ${base}${best ? ` gegen ${best.score.reply}` : ", alle Entwürfe verworfen"})`;
    await db.insert(runs).values({ tenantId: t.id, kind: "optimize", ok: true, info });
    return { added: null, info };
  }

  const taken = new Set((await db.select({ k: templates.key }).from(templates).where(eq(templates.tenantId, t.id))).map(r => r.k));
  const key = nextKey(taken);
  await db.insert(templates).values({ tenantId: t.id, key, name: best.c.name || `Variante ${key}`, tone: parent.tone, subject: best.c.subject, body: best.c.body,
    active: true, origin: `aus ${parent.key}, Jev ${base} → ${best.score.reply}`, score: best.score });

  let dropped: string | null = null;
  if (active.length + 1 > MAX_ACTIVE) {
    const worst = active[active.length - 1];
    await db.update(templates).set({ active: false }).where(eq(templates.id, worst.id));
    dropped = worst.key;
  }
  const info = `Neue Vorlage ${key} aus ${parent.key} (Jev ${base} → ${best.score.reply})${dropped ? `, ${dropped} pausiert` : ""}`;
  await db.insert(runs).values({ tenantId: t.id, kind: "optimize", ok: true, info });
  return { added: key, dropped, info };
}
