import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, leads, setups, tenants } from "@/db";
import type { FitInfo } from "@/db/schema";
import { jevKey } from "./jev";

/* How well a lead matches the tenant's ideal customer, judged by a cheap model on OpenRouter against the tenant's own segments, exclusions and personas.
   Four parts 0–4 (company, person, need, evidence) plus a knockout reason; fit 0–4 is their weighted mean with caps, so a good title never rescues a wrong company.
   About 1 ct per 100 leads with DeepSeek V4.1 Flash (thinking off, cheapest provider). A lead is judged again only when its inputs or the ideal customer change (hash). */
export const FIT_MODEL = "deepseek/deepseek-v4.1-flash";
const FALLBACK = "google/gemini-2.5-flash-lite";
const VERSION = 3, BATCH = 10, PARALLEL = 6, MAX = 400;
const RATED = ["neu", "freigabe", "angeschrieben", "beantwortet"];

/* only what the judge reads */
const COLS = { id: leads.id, company: leads.company, city: leads.city, website: leads.website, first: leads.first, last: leads.last, role: leads.role, email: leads.email,
  emailType: leads.emailType, linkedin: leads.linkedin, hook: leads.hook, note: leads.note, research: leads.research, sourceUrl: leads.sourceUrl, tenders: leads.tenders, fitInfo: leads.fitInfo };
type Lead = { [K in keyof typeof COLS]: (typeof leads.$inferSelect)[K] };
type Part = { company: number; person: number; need: number; evidence: number };

/* weights from the reviews: company 45 %, person 35 %, need 20 %; evidence only lowers confidence */
export function fitOf(p: Part, ko: string) {
  if (ko) return 0;
  let f = 0.45 * p.company + 0.35 * p.person + 0.2 * p.need;
  if (p.company <= 1) f = Math.min(f, 1.2);
  if (p.person <= 1) f = Math.min(f, 2);
  return Math.round(f * 100) / 100;
}

const list = (xs?: string[]) => (xs || []).filter(Boolean).join(", ");

/* The ideal customer as the setup knows it; the research prompt only when there is no setup */
export async function icpOf(tenantId: number) {
  const [t] = await db.select({ name: tenants.name, settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId));
  const [su] = await db.select().from(setups).where(and(eq(setups.tenantId, tenantId), sql`jsonb_array_length(${setups.segments}) > 0`))
    .orderBy(desc(setups.active), desc(setups.updatedAt)).limit(1);
  const voted = await db.select({ company: leads.company, role: leads.role, vote: leads.vote, note: leads.note }).from(leads)
    .where(and(eq(leads.tenantId, tenantId), sql`${leads.vote} <> 0`)).orderBy(desc(leads.id)).limit(8);
  const out: string[] = [`Verkäufer: ${t?.name || ""}`];
  if (su) {
    const p = su.profile;
    if (p) out.push(`Angebot: ${p.offer || p.summary}`, ...(p.audience ? [`Zielgruppe, in dieser Reihenfolge: ${p.audience}`] : []), ...(p.customers?.length ? [`Bestehende Kunden: ${list(p.customers)}`] : []));
    out.push("Segmente, das beste zuerst:", ...su.segments.map((s, i) => `${i + 1}. ${s.name}: Branchen ${list(s.industries)}${s.size ? `; Größe ${s.size}` : ""}${s.regions?.length ? `; Regionen ${list(s.regions)}` : ""}${s.triggers?.length ? `; Anlässe ${list(s.triggers)}` : ""}${s.exclude?.length ? `; nicht in diesem Segment: ${list(s.exclude)}` : ""}. ${s.why}`));
    if (su.personas.length) out.push("Ansprechpartner:", ...su.personas.map(p => `- ${p.role}${p.segment ? ` (${p.segment})` : ""}: ${list(p.titles)}`));
    const ex = [...su.leads.filter(l => l.vote), ...voted.map(v => ({ company: v.company, role: v.role, vote: v.vote, reason: v.note }))].slice(0, 10);
    if (ex.length) out.push("Urteile des Nutzers:", ...ex.map(l => `- ${l.vote! > 0 ? "passt" : "passt nicht"}: ${l.company}, ${l.role}${l.reason ? ` – ${l.reason}` : ""}`));
  } else if (t?.settings.prompt.trim()) out.push(`Recherche-Auftrag (beschreibt Angebot und Zielgruppe):\n${t.settings.prompt.slice(0, 4000)}`);
  else return "";
  return out.join("\n");
}

const SYSTEM = (icp: string) => `Du bewertest Leads für die Kaltakquise eines deutschen B2B-Anbieters. Maßstab ist allein dieses Zielkundenprofil:

${icp}

Bewerte jeden Lead nur nach seinen Angaben. Erfinde nichts; fehlt etwas, bewerte niedriger und nenne es.
Ein "nicht in diesem Segment" gilt nur für sein Segment und meint genau die genannten Firmen: Passt der Lead in ein anderes Segment, bewerte ihn dort. Steht dort z. B. "Sparkassen (über Verbände)", sind die Sparkassen selbst gemeint, ihre Verbände sind erwünscht.
- segment: Name des am besten passenden Segments, sonst "".
- ko: kurzer Grund nur in diesen Fällen: der Lead fällt unter ein "nicht" und passt in kein anderes Segment, ist Bestandskunde, Testeintrag oder keine echte Firma, oder die Person arbeitet nicht bei der Firma. Schreib den Grund in eigenen Worten mit Bezug auf den Lead, z. B. "Big Four" oder "Testeintrag, keine Firma". Passt ein Lead nur schlecht oder in kein Segment, ist das kein ko, sondern eine niedrige company. Sonst "".
- company 0–4: 0 in keinem Segment · 1 Randbereich · 2 Segment passt, Größe oder Region weicht ab oder ist unklar · 3 passt in Segment, Größe und Region · 4 wie 3 im besten Segment oder mit belegtem Bedarf.
- person 0–4: 0 keine Person oder klar falsche Funktion · 1 fachfremd · 2 angrenzend oder unklar · 3 Funktion einer Ansprechpartner-Gruppe · 4 entscheidet selbst in dieser Funktion.
- need 0–4: 0 kein Anlass · 1 nur allgemein für die Branche · 2 Thema passt, aber nicht firmenspezifisch · 3 konkreter Anlass bei dieser Firma · 4 konkret, aktuell und direkt zum Angebot.
- evidence 0–4: wie gut die Angaben belegt sind (0 nur ein Name, 4 Recherche mit Quelle).
- why: ein Satz auf Deutsch, höchstens 140 Zeichen, warum der Lead passt oder nicht.
Antworte nur mit JSON: {"leads":[{"id":…,"segment":"","ko":"","company":0,"person":0,"need":0,"evidence":0,"why":""}]}`;

const cut = (s: string, n: number) => s.length > n ? `${s.slice(0, n)} …` : s;
const view = (l: Lead) => ({
  id: l.id, firma: l.company, ort: l.city, website: l.website, person: [l.first, l.last].filter(Boolean).join(" ") || "(kein Name)", rolle: l.role,
  kontakt: l.email ? (l.emailType === "info" ? "Sammeladresse" : "persönliche E-Mail") : l.linkedin ? "nur LinkedIn" : "keiner",
  anlass: l.hook, notiz: cut(l.note, 400), recherche: cut(l.research, 900), quelle: l.sourceUrl, ausschreibungen: l.tenders.map(t => t.t).join("; "),
});
export const fitHash = (icp: string, l: Lead) => createHash("sha1").update(JSON.stringify([VERSION, icp, view(l)])).digest("hex").slice(0, 16);

const SCHEMA = { type: "object", additionalProperties: false, required: ["leads"], properties: { leads: { type: "array", items: { type: "object", additionalProperties: false,
  required: ["id", "segment", "ko", "company", "person", "need", "evidence", "why"],
  properties: { id: { type: "integer" }, segment: { type: "string" }, ko: { type: "string" }, company: { type: "number" }, person: { type: "number" }, need: { type: "number" }, evidence: { type: "number" }, why: { type: "string" } } } } } };

type Judged = Part & { id: number; segment: string; ko: string; why: string };

/* a knockout without a real reason is the model echoing the instructions: it counts as a poor fit, not as excluded */
export const realKo = <T extends { ko: string; company: number }>(x: T): T =>
  x.ko && (x.ko.length < 3 || /^(ko|ja|yes|true|x)$|fällt unter ein|der lead/i.test(x.ko)) ? { ...x, ko: "", company: Math.min(x.company, 1) } : x;
const clamp = (x: unknown) => Math.max(0, Math.min(4, Number(x) || 0));

async function judge(key: string, icp: string, batch: Lead[]): Promise<{ got: Judged[]; model: string }> {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "Sales Portal", "http-referer": "https://sales-portal-sooty.vercel.app" },
    body: JSON.stringify({
      models: [FIT_MODEL, FALLBACK], temperature: 0, max_tokens: 6000, reasoning: { enabled: false }, provider: { sort: "price" },
      response_format: { type: "json_schema", json_schema: { name: "lead_fit", strict: true, schema: SCHEMA } },
      messages: [{ role: "system", content: SYSTEM(icp) }, { role: "user", content: JSON.stringify(batch.map(view)) }],
    }),
  });
  const j = await r.json().catch(() => ({})) as { model?: string; error?: { message?: string }; choices?: { message?: { content?: string } }[] };
  if (!r.ok) throw new Error(`OpenRouter: ${j.error?.message || r.status}`);
  const text = (j.choices?.[0]?.message?.content || "").replace(/^```(?:json)?\s*|\s*```$/g, "");
  const raw = (JSON.parse(text) as { leads?: Judged[] }).leads || [];
  return { model: j.model || FIT_MODEL, got: raw.map(x => ({ id: Number(x.id), segment: String(x.segment || ""), ko: String(x.ko || "").trim(), why: String(x.why || "").slice(0, 200),
    company: clamp(x.company), person: clamp(x.person), need: clamp(x.need), evidence: clamp(x.evidence) }))
    .map(realKo) };
}

export type FitRun = { judged: number; failed: number; error?: string };

/* Judges every rated lead whose inputs changed since its last judgement (or `only`), in batches of 10, four at a time; a failed batch keeps its leads for the next run */
export async function fitLeads(tenantId: number, only?: number[]): Promise<FitRun> {
  const key = await jevKey(tenantId);
  if (!key) return { judged: 0, failed: 0, error: "Kein OpenRouter-Schlüssel" };
  const icp = await icpOf(tenantId);
  if (!icp) return { judged: 0, failed: 0, error: "Kein Zielkundenprofil" };
  const all = await db.select(COLS).from(leads).where(and(eq(leads.tenantId, tenantId), inArray(leads.status, RATED), only ? inArray(leads.id, only.length ? only : [0]) : undefined));
  const todo = all.filter(l => l.fitInfo?.hash !== fitHash(icp, l)).slice(0, MAX);
  const batches: Lead[][] = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  let judged = 0, failed = 0, error: string | undefined;
  for (let i = 0; i < batches.length; i += PARALLEL) {
    await Promise.all(batches.slice(i, i + PARALLEL).map(async b => {
      try {
        /* a cut-off or broken answer is asked again in two halves */
        const { got, model } = await judge(key, icp, b).catch(async e => {
          if (!(e instanceof SyntaxError) || b.length < 2) throw e;
          const h = Math.ceil(b.length / 2), [x, y] = await Promise.all([judge(key, icp, b.slice(0, h)), judge(key, icp, b.slice(h))]);
          return { got: [...x.got, ...y.got], model: x.model };
        });
        /* an entry without any reason is an incomplete answer; that lead waits for the next run */
        const by = new Map(got.filter(g => g.why || g.ko).map(g => [g.id, g])), at = new Date().toISOString();
        const rows = b.filter(l => by.has(l.id)).map(l => {
          const g = by.get(l.id)!;
          const info: FitInfo = { company: g.company, person: g.person, need: g.need, evidence: g.evidence, segment: g.segment, ko: g.ko, why: g.why, model, hash: fitHash(icp, l), at };
          return sql`(${l.id}::int, ${fitOf(g, g.ko)}::real, ${JSON.stringify(info)}::jsonb)`;
        });
        failed += b.length - rows.length; judged += rows.length;
        if (rows.length) await db.execute(sql`update leads set fit = v.fit, fit_info = v.info from (values ${sql.join(rows, sql`, `)}) as v(id, fit, info) where leads.id = v.id`);
      } catch (e) {
        failed += b.length; error = (e as Error).message;
        console.error("fit", tenantId, error);
      }
    }));
  }
  return { judged, failed, ...(error ? { error } : {}) };
}
