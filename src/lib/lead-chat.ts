import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { db, leads, tenants } from "@/db";
import { HttpError, checkEmail } from "./api";
import type { Ai } from "./ai";
import { ask, json } from "./claude";
import { attachCompanies } from "./companies";
import { berlinDate } from "./dates";
import { cleanLead, emailTypeOf, LEAD_FIELDS } from "./lead-fields";
import { channelOf, domain } from "./lead-rating";
import { setLeadStatus } from "./outreach";
import { bouncedDomains, liQueue, mailQueue, sendDates, setQueue } from "./queue";
import { later, refreshRatings } from "./ratings";

type Tenant = typeof tenants.$inferSelect;
export type ChatMsg = { role: "user" | "assistant"; content: string };

const STATUS = ["neu", "angeschrieben", "beantwortet", "unzustellbar", "dublette", "kontakt", "papierkorb"] as const;
const s = () => z.string().optional();
const Edit = z.object({
  id: z.number().int(), status: z.enum(STATUS).optional(), channel: z.enum(["", "mail", "linkedin"]).optional(), vote: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
  ...Object.fromEntries(LEAD_FIELDS.map(k => [k, s()])) as Record<typeof LEAD_FIELDS[number], ReturnType<typeof s>>,
});
const Out = z.object({ reply: z.string(), order: z.array(z.number().int()).nullish(), updates: z.array(Edit).nullish() });


const cut = (v: string, n: number) => v.replace(/[\n;]+/g, " ").trim().slice(0, n);

/* One line per lead, in send order: what the AI needs to sort and change the list */
async function listFor(t: Tenant) {
  const rows = await db.select().from(leads).where(and(eq(leads.tenantId, t.id), ne(leads.status, "papierkorb")));
  const bounced = await bouncedDomains(t.id), queue = await mailQueue(t), days = await sendDates(t, queue, await liQueue(t));
  const pos = new Map(queue.map((q, i) => [q.id, i]));
  rows.sort((a, b) => (days[a.id] || "9").localeCompare(days[b.id] || "9") || (pos.get(a.id) ?? Infinity) - (pos.get(b.id) ?? Infinity) || (b.rating ?? -1) - (a.rating ?? -1));
  const lines = rows.slice(0, 2500).map(r => [r.id, cut(r.company, 60), cut([r.first, r.last].filter(Boolean).join(" "), 40), cut(r.role, 40), cut(r.city, 40),
    r.website.replace(/^https?:\/\/(www\.)?/i, "").split("/")[0].toLowerCase() || domain(r.email), r.status, r.rating ?? "", r.sendpilotAt ? "linkedin" : channelOf(r, bounced).ch,
    days[r.id] || "", pos.has(r.id) ? pos.get(r.id)! + 1 : "", cut(r.note, 80)].join(";"));
  return { ids: new Set(rows.map(r => r.id)), text: `id;Firma;Person;Rolle;Ort;Domain;Status;Bewertung;Kanal;Versandtag;Platz;Notiz\n${lines.join("\n")}` };
}

/* Field edits as the lead dialog makes them: address checks first, so a bad address changes nothing */
async function applyEdits(tenantId: number, edits: z.infer<typeof Edit>[]) {
  const found = new Map((await db.select().from(leads).where(and(eq(leads.tenantId, tenantId), inArray(leads.id, edits.map(e => e.id))))).map(l => [l.id, l]));
  const todo = edits.filter(e => found.has(e.id));
  for (const e of todo) { const v = cleanLead(e), l = found.get(e.id)!; if (v.email && v.email.toLowerCase() !== l.email.toLowerCase()) await checkEmail(tenantId, v.email, e.id); }
  let moved = false;
  for (const { id, status, channel, vote, ...f } of todo) {
    const l = found.get(id)!, v: Partial<typeof leads.$inferInsert> = cleanLead(f);
    if (v.company === "") delete v.company;
    if (v.email !== undefined || v.first !== undefined || v.last !== undefined) v.emailType = emailTypeOf(v.email ?? l.email, !!((v.first ?? l.first) || (v.last ?? l.last)));
    if (v.company !== undefined && v.company !== l.company) { v.companyId = null; moved = true; }
    if (channel !== undefined) v.channel = channel;
    if (vote !== undefined) v.vote = vote;
    if (Object.keys(v).length) await db.update(leads).set(v).where(eq(leads.id, id));
    if (status && status !== l.status) await setLeadStatus(tenantId, id, status);
  }
  if (moved) await attachCompanies(tenantId);
  return todo.map(e => e.id);
}

/* The chat under the lead list: the AI reads the whole list, answers, and changes order and leads in the same step */
export async function leadChat(ai: Ai, t: Tenant, history: ChatMsg[]) {
  const list = await listFor(t), n = Math.max(1, Math.min(30, t.settings.leadsPerDay || 10));
  const talk = history.slice(-12).map(m => `${m.role === "user" ? "Nutzer" : "Du"}: ${m.content}`).join("\n\n");
  const text = await ask({
    key: ai, effort: "low",
    system: `Du arbeitest in der Lead-Liste eines Vertriebsportals (Mandant ${t.name}) und hilfst dem Nutzer, die Liste zu ordnen und zu pflegen. Heute ist ${berlinDate()}.
Die Liste steht unten als CSV mit Semikolon, in der Reihenfolge, in der angeschrieben wird. Versandtag = Tag, an dem der Lead angeschrieben wird; Platz = Stelle in der Versand-Warteschlange (nur Status neu). Je Versandtag gehen bis zu ${n} Personen je Kanal raus, Kontakte derselben Firma am selben Tag.
Status: neu (noch nicht angeschrieben), freigabe (Entwurf wartet), angeschrieben, beantwortet, unzustellbar, dublette, kontakt (bestehende Beziehung, nie kalt anschreiben), papierkorb.

Du kannst:
- order: Lead-ids in der gewünschten Reihenfolge; sie kommen an den Anfang der Warteschlange, alle anderen folgen nach Bewertung. Für „diese Woche nur X“ alle passenden Leads mit Status neu nach vorn, die besten zuerst. Eine neue order ersetzt die bisher gesetzte Reihenfolge vollständig.
- updates: Änderungen je Lead mit id und nur den geänderten Feldern: status, channel ("mail", "linkedin", "" = Empfehlung), vote (1 guter Lead, -1 schlechter, 0 neutral), ${LEAD_FIELDS.join(", ")}. Aussortieren = status "papierkorb".
Ordne Orte und Regionen mit deinem Wissen über Geografie zu (z. B. Rhein-Main: Frankfurt, Offenbach, Wiesbaden, Darmstadt, Hanau, Bad Homburg, Oberursel, Hochtaunuskreis, Main-Taunus-Kreis). Ohne Ort nimm die Domain oder den Firmennamen als Hinweis und sag, wenn du dir nicht sicher bist.
Ändere nur, worum der Nutzer bittet. Bei bloßen Fragen keine Änderungen. Erfinde keine Kontaktdaten.
reply: kurze Antwort auf Deutsch, du-Form, ohne Floskeln: was du geändert hast (mit Zahl der Leads und wie viele Versandtage das füllt) oder die Antwort auf die Frage. Markdown erlaubt, Listen höchstens zehn Einträge.
Antworte nur mit \`\`\`json {"reply":"…","order":[…] oder null,"updates":[…] oder null}\`\`\`.

Leads:
${list.text}`,
    prompt: talk,
  });
  const out = json(text, Out);
  const done: string[] = [];
  let changed = 0;
  if (out.updates?.length) {
    const ids = await applyEdits(t.id, out.updates.filter(u => list.ids.has(u.id)).slice(0, 500)).catch(e => { if (e instanceof HttpError) { done.push(`Nicht gespeichert: ${e.message}`); return []; } throw e; });
    changed += ids.length;
    if (ids.length) await later(() => refreshRatings(t.id, ids));
  }
  if (out.order?.length) {
    const ids = [...new Set(out.order.filter(id => list.ids.has(id)))].slice(0, 2000);
    await setQueue(t.id, ids); changed += ids.length;
  }
  return { reply: [out.reply, ...done].join("\n\n"), changed };
}
