import { eq } from "drizzle-orm";
import { db, messages, tenants } from "@/db";
import { HttpError, assertMember, body, idOf, route } from "@/lib/api";
import { calibration, draftText, judge } from "@/lib/drafts";
import { jevKey } from "@/lib/jev";
import { writeMails } from "@/lib/writer";
import { words } from "@/lib/playbook";

type Ctx = { params: Promise<{ id: string }> };
export const maxDuration = 120;

/* Takes a rewrite only if Jev rates it at least this much higher; anything less is noise */
const MIN_GAIN = 5;

/* "Verbessern": Grok rewrites the draft as shown, Jev scores each version, the best one replaces the text if it is clearly better */
export const POST = route<Ctx>(async (req, { params }, me) => {
  const id = await idOf(params, "Nachricht"), b = await body(req);
  const [m] = await db.select().from(messages).where(eq(messages.id, id));
  if (!m) throw new HttpError(404, "Nachricht nicht gefunden");
  await assertMember(me, m.tenantId, "Nachricht");
  const key = await jevKey(m.tenantId, me.id);
  if (!key) throw new HttpError(400, "OpenRouter ist nicht verbunden (für Grok und Jev)");
  const [t] = await db.select().from(tenants).where(eq(tenants.id, m.tenantId));
  const shown = await draftText(m), l = shown.lead;
  const text = typeof b.subject === "string" && typeof b.body === "string" ? { subject: b.subject, body: b.body } : shown;
  const cal = await calibration(m.tenantId);
  const now = await judge(key, text, l, m.score, cal);

  const facts = [`Firma: ${l.company}`, l.city && `Ort: ${l.city}`, l.role && `Rolle: ${l.role}`, l.hook && `Anlass: ${l.hook}`,
    l.tenders.length && `Ausschreibungen: ${l.tenders.map(x => `${x.t} (${x.s}${x.f ? `, Frist ${x.f}` : ""})`).join("; ")}`].filter(Boolean).join("\n");
  const prompt = `Angebot und Zielgruppe:
${t.settings.prompt.slice(0, 1500)}

Empfänger:
${facts}

Aktuelle Mail (Score ${now.total} von 100${now.issues?.length ? `, Schwächen: ${now.issues.join(", ")}` : ""}${now.weakness && now.weakness !== "none" ? `, Haupthindernis laut Bewertung: ${now.weakness}` : ""}):
Betreff: ${text.subject}

${text.body}

Verbessere diese Mail. Erfinde keine Fakten, nutze nur, was oben steht.`;

  const drafts = (await writeMails(m.tenantId, prompt, 2, me.id)).filter(d => words(d.body) <= 100 && !/https?:\/\//.test(d.body));
  let best: { subject: string; body: string; score: typeof now } | null = null;
  for (const d of drafts) {
    const score = await judge(key, d, l, null, cal);
    if (!best || score.total! > best.score.total!) best = { subject: d.subject, body: d.body, score };
  }
  if (!best || best.score.total! < now.total! + MIN_GAIN) {
    await db.update(messages).set({ score: now }).where(eq(messages.id, id));
    return { improved: false, score: { total: now.total, issues: now.issues } };
  }
  await db.update(messages).set({ subject: best.subject, body: best.body, score: best.score, improved: true }).where(eq(messages.id, id));
  return { improved: true, subject: best.subject, body: best.body, score: { total: best.score.total, issues: best.score.issues, ...(best.score.expected !== undefined ? { expected: best.score.expected } : {}) } };
});
