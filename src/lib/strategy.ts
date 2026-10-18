import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { angles, db, leads, messages, runs, tenants } from "@/db";
import { ask, json, researchLeads, type LeadOut } from "./claude";
import { aiFor, type Ai } from "./ai";
import { attachCompanies, norm } from "./companies";
import { salutationOf } from "./lead-fields";
import { pickAngles, rotation, roundsDue, startAngles, angleScore, type AngleStat } from "./angles";
import { refreshRatings } from "./ratings";
import { berlinDate } from "./dates";

type Tenant = typeof tenants.$inferSelect;
type Angle = typeof angles.$inferSelect;
export type AngleRow = Angle & AngleStat & { leads: number; score: number };

/* The first directions come from the prompt's industry line */
export async function ensureAngles(t: Tenant) {
  const [one] = await db.select({ id: angles.id }).from(angles).where(eq(angles.tenantId, t.id)).limit(1);
  if (one) return;
  await db.insert(angles).values(startAngles(t.settings.prompt).map(label => ({ tenantId: t.id, label, query: label === "Allgemein" ? "" : label, origin: "start" })));
}

/* Each direction with its leads, delivered mails, replies and the mean expected reply rate of its rated leads as prior */
export async function angleStats(tenantId: number): Promise<AngleRow[]> {
  const list = await db.select().from(angles).where(eq(angles.tenantId, tenantId)).orderBy(angles.id);
  if (!list.length) return [];
  const ls = await db.select({ angleId: leads.angleId, n: sql<number>`count(*)`.mapWith(Number),
    prior: sql<number | null>`avg((${leads.ratingInfo}->>'expected')::float)`.mapWith(v => v === null ? null : Number(v)) })
    .from(leads).where(and(eq(leads.tenantId, tenantId), isNotNull(leads.angleId))).groupBy(leads.angleId);
  const ms = await db.select({ angleId: leads.angleId, sent: sql<number>`count(${messages.sentAt}) - count(${messages.bouncedAt})`.mapWith(Number), replies: sql<number>`count(${messages.repliedAt})`.mapWith(Number) })
    .from(messages).innerJoin(leads, eq(leads.id, messages.leadId)).where(and(eq(messages.tenantId, tenantId), isNotNull(leads.angleId))).groupBy(leads.angleId);
  return list.map(a => {
    const l = ls.find(x => x.angleId === a.id), m = ms.find(x => x.angleId === a.id);
    const s = { ...a, leads: l?.n ?? 0, sent: m?.sent ?? 0, replies: m?.replies ?? 0, prior: l?.prior ?? 0.04 };
    return { ...s, score: Math.round(angleScore(s) * 1000) / 1000 };
  });
}

const Proposed = z.object({ angles: z.array(z.object({ label: z.string().min(2).max(80), query: z.string().max(400).nullish().transform(v => v ?? "") })) });

/* Two new directions from what worked, what did not, and which leads the user liked */
export async function proposeAngles(t: Tenant, key: Ai, list: AngleRow[]) {
  const ranked = [...list].sort((a, b) => b.score - a.score);
  const voted = await db.select({ company: leads.company, role: leads.role, hook: leads.hook, vote: leads.vote, angleId: leads.angleId }).from(leads)
    .where(and(eq(leads.tenantId, t.id), ne(leads.vote, 0))).limit(20);
  const line = (a: AngleRow) => `- ${a.label}${a.query && a.query !== a.label ? ` (${a.query})` : ""}: ${a.leads} Leads, ${a.sent} Mails, ${a.replies} Antworten, Erfolg ${(a.score * 100).toFixed(1)} %${a.active ? "" : ", pausiert"}`;
  const text = await ask({
    key, effort: "medium",
    system: "Du planst die Lead-Recherche für B2B-Kaltakquise im Mittelstand. Eine Suchrichtung ist eine Zielgruppe plus ein Anlass, über den die Websuche passende Firmen findet.",
    prompt: `Angebot und Zielgruppe:
${t.settings.prompt.slice(0, 2000)}

Bisherige Suchrichtungen, beste zuerst:
${ranked.map(line).join("\n")}
${voted.length ? `\nUrteil des Nutzers über einzelne Leads:\n${voted.map(v => `- ${v.vote > 0 ? "gut" : "schlecht"}: ${v.company}${v.role ? `, ${v.role}` : ""}${v.hook ? `, Anlass ${v.hook}` : ""}${v.angleId ? `, aus „${list.find(a => a.id === v.angleId)?.label ?? "?"}“` : ""}`).join("\n")}` : ""}

Schlage 2 neue Suchrichtungen vor, die sich von allen bisherigen unterscheiden: eine, die das Beste weiterdenkt, und eine, die etwas Neues ausprobiert. Meide, was schlecht lief.
label: höchstens 5 Wörter. query: eine Anweisung für die Websuche, welche Firmen mit welchem Anlass gesucht werden.
Antworte nur mit \`\`\`json {"angles":[{"label":"…","query":"…"}]}\`\`\`.`,
  });
  const seen = new Set(list.map(a => norm(a.label)));
  const fresh = json(text, Proposed).angles.filter(a => !seen.has(norm(a.label))).slice(0, 2);
  if (fresh.length) await db.insert(angles).values(fresh.map(a => ({ tenantId: t.id, label: a.label, query: a.query, origin: "ki" })));
  return fresh;
}

/* One research round: picks directions by Thompson sampling, researches about `want` new companies, files them with their direction,
   rates them, and lets the strategy rotate. Returns how many leads were added. */
export async function researchRound(t: Tenant, want: number, key?: Ai | null) {
  key ??= await aiFor(t.id);
  if (!key) return { added: 0 };
  await ensureAngles(t);
  let list = await angleStats(t.id);
  const chosen = pickAngles(list, want >= 6 ? 3 : want >= 3 ? 2 : 1);
  const per = Math.ceil(want / Math.max(1, chosen.length));
  /* every known company is skipped; the newest 400 are named to the research so it does not look for them */
  const known = await db.select({ company: leads.company }).from(leads).where(eq(leads.tenantId, t.id)).orderBy(desc(leads.createdAt));
  const seen = new Set(known.map(k => norm(k.company)));
  const exclude = known.slice(0, 400).map(k => k.company);
  const results = await Promise.allSettled(chosen.map(a => researchLeads(key!, t.settings.prompt, per, exclude, a.query || (a.label === "Allgemein" ? "" : a.label), t.tenders)));

  const added: number[] = [];
  for (const [i, r] of results.entries()) {
    if (r.status === "rejected") { await db.insert(runs).values({ tenantId: t.id, kind: "research", ok: false, info: String(r.reason?.message || r.reason).slice(0, 500) }); continue; }
    /* several people of one company arrive as several entries with the same company name */
    const fresh = new Set<string>();
    for (const f of r.value as LeadOut[]) {
      const k = norm(f.company);
      if (!k || (seen.has(k) && !fresh.has(k))) continue;
      seen.add(k); fresh.add(k);
      const [row] = await db.insert(leads).values({ tenantId: t.id, ...f, salutation: salutationOf(f.salutation), source: "Claude-Recherche", status: "neu", angleId: chosen[i].id }).returning({ id: leads.id });
      added.push(row.id);
    }
  }
  if (chosen.length) await db.update(angles).set({ rounds: sql`${angles.rounds} + 1` }).where(inArray(angles.id, chosen.map(a => a.id)));
  await attachCompanies(t.id);
  await refreshRatings(t.id, added);

  /* the strategy changes after the round has been counted */
  await db.insert(runs).values({ tenantId: t.id, kind: "round", ok: true, info: `${added.length} Leads: ${chosen.map(a => a.label).join(", ")}`.slice(0, 500) });
  const [{ rounds }] = await db.select({ rounds: sql<number>`count(*)`.mapWith(Number) }).from(runs).where(and(eq(runs.tenantId, t.id), eq(runs.kind, "round")));
  list = await angleStats(t.id);
  const rot = rotation(list, rounds);
  if (rot.propose) await proposeAngles(t, key, list).catch(e => db.insert(runs).values({ tenantId: t.id, kind: "strategy", ok: false, info: String(e.message).slice(0, 500) }));
  list = await angleStats(t.id);
  const again = rotation(list, 0);
  if (again.retire) await db.update(angles).set({ active: false }).where(eq(angles.id, again.retire));
  return { added: added.length, angles: chosen.map(a => a.label) };
}

const berlinHour = (d: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hour12: false }).format(d)) % 24;

/* Half-hourly tick: one round if one is due for this tenant today; each round brings leadsPerDay new leads, all of them kept and rated */
export async function researchLoop(t: Tenant, now = new Date()) {
  const perDay = t.settings.roundsPerDay ?? 0;
  if (!perDay) return { rounds: 0, added: 0 };
  const [{ done }] = await db.select({ done: sql<number>`count(*)`.mapWith(Number) }).from(runs)
    .where(and(eq(runs.tenantId, t.id), eq(runs.kind, "loop"), sql`(${runs.createdAt} at time zone 'Europe/Berlin')::date = ${berlinDate(now)}::date`));
  const due = roundsDue(perDay, done, berlinHour(now));
  if (!due) return { rounds: 0, added: 0 };
  /* counted before it runs, so a round cut off by the time limit is not repeated */
  const [run] = await db.insert(runs).values({ tenantId: t.id, kind: "loop", ok: false, info: "läuft" }).returning({ id: runs.id });
  const r = await researchRound(t, Math.max(1, Math.min(30, t.settings.leadsPerDay || 10)));
  await db.update(runs).set({ ok: true, info: `${r.added} neue Leads` }).where(eq(runs.id, run.id));
  return { rounds: 1, added: r.added };
}
