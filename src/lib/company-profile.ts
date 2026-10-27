import { createHash } from "node:crypto";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { companies, db, leads } from "@/db";
import type { CompanyProfile } from "@/db/schema";
import { jevKey } from "./jev";
import { FREEMAIL, domain } from "./lead-rating";
import type { Rubric } from "./rubrics";
import { spend, track } from "./usage";

/* What kind of organisation a company is, how big and how close to the offer, by the tenant's rubric (lib/rubrics.ts).
   First from the model's own knowledge, ten companies a call; a company it is unsure of and that has a real domain is looked up on the web,
   one a call with Perplexity Sonar (one search, about half a cent plus tokens), at most WEB_BUDGET dollars a run; what is left waits for the next run.
   A company is judged again only when its inputs or the rubric change (hash). */
export const PROFILE_MODEL = "google/gemini-3.8-flash";
const FALLBACK = "google/gemini-3.5-flash";
export const WEB_MODEL = "perplexity/sonar";
const VERSION = 1, BATCH = 10, PARALLEL = 6, MAX = 300, WEB_PARALLEL = 5, WEB_BUDGET = 0.4, UNSURE = 0.6;
const SKIP = ["papierkorb", "dublette"];

type Lead = { companyId: number | null; company: string; email: string; website: string; city: string; role: string; hook: string; note: string; research: string; touch: { notes: string } | null };
type Co = { id: number; name: string; domain: string; profile: CompanyProfile | null };
export type CoView = { id: number; firma: string; domain: string; ort: string; personen: number; rollen: string; adressen: string; anlass: string; notizen: string };

const cut = (s: string, n: number) => s.length > n ? `${s.slice(0, n)} …` : s;
const uniq = (xs: string[]) => [...new Set(xs.map(x => x.trim()).filter(Boolean))];
const hostOf = (u: string) => { try { return new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, ""); } catch { return ""; } };

/* what the model reads about a company: its name and domain, what its people's addresses and titles say, and what we noted */
export function viewOf(c: Co, people: Lead[]): CoView {
  const mails = people.map(p => p.email).filter(Boolean);
  const own = uniq([c.domain, ...mails.filter(m => !FREEMAIL.test(m)).map(domain), ...people.map(p => hostOf(p.website))]);
  return {
    id: c.id, firma: c.name, domain: own[0] || (mails.length ? "keine, nur Freemail" : ""), ort: uniq(people.map(p => p.city)).join(", "), personen: people.length,
    rollen: uniq(people.map(p => p.role)).slice(0, 5).join("; "),
    /* only the part before the @: info@, vergabe@ or a name say something, the rest is the domain */
    adressen: uniq(mails.map(m => m.split("@")[0])).slice(0, 5).join(", "),
    anlass: cut(uniq(people.flatMap(p => [p.hook, p.note])).join(" · "), 400),
    notizen: cut(uniq(people.flatMap(p => [p.touch?.notes || "", cut(p.research, 500)])).join(" · "), 900),
  };
}
export const profileHash = (r: Rubric, v: CoView) => createHash("sha1").update(JSON.stringify([VERSION, r, v])).digest("hex").slice(0, 16);

const opts = (xs: { key: string; label: string; hint: string }[]) => xs.map(x => `- ${x.key}: ${x.label}${x.hint ? ` (${x.hint})` : ""}`).join("\n");
const SYSTEM = (r: Rubric, web: boolean) => `Du ordnest Firmen für den Vertrieb eines deutschen B2B-Anbieters ein.

${r.brief}

Wähle je Firma aus diesen Listen genau einen Schlüssel.
type, Art der Organisation:
${opts(r.types)}
size, Größe:
${opts(r.sizes)}
fit, Nähe zum Angebot:
${opts(r.fits)}
signals, nur was belegt ist (sonst leer):
${opts(r.signals)}

Regeln:
- Nutze dein Wissen über die Firma (Name und Domain) und die Angaben. ${web ? "Suche im Web nach Größe und Tätigkeit der Firma und stütze dich auf die Treffer." : "Kennst du die Firma nicht, schätze aus Name, Domain und Angaben und setze sure niedrig."}
- Hat die Firma keine eigene Domain (nur Freemail) und kennst du sie nicht, nimm die kleinste Größe und setze sure niedrig. Das ist kein Testeintrag: Wähle test nur, wenn Name oder Adresse eindeutig unecht sind.
- wettbewerber nur für Anbieter, die in der Liste genannt sind oder dasselbe verkaufen, nie für Freemail-Anbieter.
- Notizen stammen aus Gesprächen des Vertriebs und wiegen schwerer als Vermutungen.
- employees: geschätzte Mitarbeiterzahl in Deutschland, sonst weltweit; 0, wenn du es nicht weißt.
- sure: 0 bis 1, wie sicher du bei type und size bist. Unter 0.6 heißt: im Web nachsehen lohnt sich.
- why: ein Satz auf Deutsch, höchstens 140 Zeichen, was die Firma macht und warum sie so eingeordnet ist.
Antworte nur mit JSON: {"companies":[{"id":…,"type":"","size":"","fit":"","signals":[],"employees":0,"why":"","sure":0}]}`;

const schemaOf = (r: Rubric) => ({ type: "object", additionalProperties: false, required: ["companies"], properties: { companies: { type: "array", items: { type: "object", additionalProperties: false,
  required: ["id", "type", "size", "fit", "signals", "employees", "why", "sure"],
  properties: { id: { type: "integer" }, type: { type: "string", enum: r.types.map(t => t.key) }, size: { type: "string", enum: r.sizes.map(t => t.key) },
    fit: { type: "string", enum: r.fits.map(t => t.key) }, signals: { type: "array", items: { type: "string", enum: r.signals.map(t => t.key) } },
    employees: { type: "integer" }, why: { type: "string" }, sure: { type: "number" } } } } } });

type Judged = Omit<CompanyProfile, "web" | "sources" | "model" | "hash" | "at"> & { id: number };

/* keeps only keys the rubric knows; anything else becomes the rubric's "don't know" */
export function cleanJudged(r: Rubric, x: Record<string, unknown>): Judged {
  const pick = (xs: { key: string }[], v: unknown, dflt: string) => xs.some(o => o.key === v) ? String(v) : dflt;
  return {
    id: Number(x.id), type: pick(r.types, x.type, "unklar"), size: pick(r.sizes, x.size, r.sizes.find(s => /unklar|x$/.test(s.key))?.key || r.sizes[0].key),
    fit: pick(r.fits, x.fit, r.fits.find(f => f.key === "unklar")?.key || r.fits[r.fits.length - 1].key),
    signals: uniq(Array.isArray(x.signals) ? x.signals.map(String) : []).filter(k => r.signals.some(s => s.key === k)),
    employees: Number(x.employees) > 0 ? Math.round(Number(x.employees)) : null, why: String(x.why || "").slice(0, 200), sure: Math.max(0, Math.min(1, Number(x.sure) || 0)),
  };
}

export async function judge(key: string, r: Rubric, batch: CoView[], web: boolean): Promise<{ got: Judged[]; model: string; sources: string[]; cost: number }> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "Sales Portal", "http-referer": "https://sales-portal-sooty.vercel.app" },
    body: JSON.stringify({
      ...(web ? { model: WEB_MODEL, max_tokens: 1500 } : { models: [PROFILE_MODEL, FALLBACK], max_tokens: 8000, reasoning: { effort: "low" } }), temperature: 0, usage: { include: true },
      response_format: { type: "json_schema", json_schema: { name: "company_profile", strict: true, schema: schemaOf(r) } },
      messages: [{ role: "system", content: SYSTEM(r, web) }, { role: "user", content: JSON.stringify(batch) }],
    }),
  });
  const j = await res.json().catch(() => ({})) as { model?: string; error?: { message?: string }; usage?: { cost?: number }; citations?: string[];
    choices?: { message?: { content?: string; annotations?: { type: string; url_citation?: { url: string } }[] } }[] };
  if (!res.ok) throw new Error(`OpenRouter: ${j.error?.message || res.status}`);
  spend(j.usage?.cost);
  const msg = j.choices?.[0]?.message;
  const raw = (JSON.parse((msg?.content || "").replace(/^```(?:json)?\s*|\s*```$/g, "")) as { companies?: Record<string, unknown>[] }).companies || [];
  const sources = uniq([...(msg?.annotations || []).map(a => a.url_citation?.url || ""), ...(j.citations || [])]).slice(0, 3);
  return { model: j.model || PROFILE_MODEL, sources, cost: j.usage?.cost || 0, got: raw.map(x => cleanJudged(r, x)) };
}

export type ProfileRun = { judged: number; web: number; failed: number; error?: string };

export const profileCompanies = (tenantId: number, r: Rubric, only?: number[]) => track({ tenantId, kind: "bewertung" }, async m => {
  const out = await profile(tenantId, r, only);
  m.count(out.judged);
  return out;
});

async function profile(tenantId: number, r: Rubric, only?: number[]): Promise<ProfileRun> {
  const key = await jevKey(tenantId);
  if (!key) return { judged: 0, web: 0, failed: 0, error: "Kein OpenRouter-Schlüssel" };
  const [people, cos] = await Promise.all([
    db.select({ companyId: leads.companyId, company: leads.company, email: leads.email, website: leads.website, city: leads.city, role: leads.role, hook: leads.hook, note: leads.note,
      research: leads.research, touch: leads.touch }).from(leads).where(and(eq(leads.tenantId, tenantId), notInArray(leads.status, SKIP))),
    db.select({ id: companies.id, name: companies.name, domain: companies.domain, profile: companies.profile }).from(companies)
      .where(and(eq(companies.tenantId, tenantId), only ? inArray(companies.id, only.length ? only : [0]) : undefined))]);
  const byCo = new Map<number, Lead[]>();
  for (const p of people) if (p.companyId != null) byCo.set(p.companyId, [...(byCo.get(p.companyId) || []), p]);
  const all = cos.filter(c => byCo.has(c.id)).map(c => ({ c, v: viewOf(c, byCo.get(c.id)!) })).map(x => ({ ...x, hash: profileHash(r, x.v) }));
  const todo = all.filter(x => x.c.profile?.hash !== x.hash).slice(0, MAX);
  const hashOf = new Map(all.map(x => [x.c.id, x.hash])), viewById = new Map(all.map(x => [x.c.id, x.v]));
  /* worth a web search: unsure, a real company domain, not a test entry */
  const lookup = (id: number, p: { sure: number; type: string; web?: boolean }) => {
    const v = viewById.get(id);
    return !p.web && p.sure < UNSURE && p.type !== "test" && !!v && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v.domain);
  };
  let judged = 0, web = 0, failed = 0, error: string | undefined;
  const save = async (list: Judged[], model: string, sources: string[], looked: boolean) => {
    const at = new Date().toISOString();
    for (const g of list) {
      if (!hashOf.has(g.id) || (!g.why && !looked)) { failed++; continue; }
      const p: CompanyProfile = { type: g.type, size: g.size, fit: g.fit, signals: g.signals, employees: g.employees, why: g.why, sure: g.sure, web: looked, sources, model, hash: hashOf.get(g.id)!, at };
      await db.update(companies).set({ profile: p }).where(and(eq(companies.id, g.id), eq(companies.tenantId, tenantId)));
      judged++;
    }
  };

  /* pass 1: what the model knows; companies judged before whose web search is still due come along to pass 2 */
  const unsure: number[] = all.filter(x => x.c.profile?.hash === x.hash && lookup(x.c.id, x.c.profile!)).map(x => x.c.id);
  const batches: CoView[][] = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH).map(x => x.v));
  for (let i = 0; i < batches.length; i += PARALLEL) {
    await Promise.all(batches.slice(i, i + PARALLEL).map(async b => {
      try {
        const { got, model } = await judge(key, r, b, false);
        await save(got, model, [], false);
        for (const g of got) if (lookup(g.id, g)) unsure.push(g.id);
        failed += b.filter(v => !got.some(g => g.id === v.id)).length;
      } catch (e) { failed += b.length; error = (e as Error).message; console.error("profile", tenantId, error); }
    }));
  }
  /* pass 2: the unsure ones looked up on the web, until the run's budget is spent */
  let spent = 0;
  for (let i = 0; i < unsure.length && spent < WEB_BUDGET; i += WEB_PARALLEL) {
    await Promise.all(unsure.slice(i, i + WEB_PARALLEL).map(async id => {
      try {
        const { got, model, sources, cost } = await judge(key, r, [viewById.get(id)!], true);
        spent += cost;
        const g = got.find(x => x.id === id);
        /* a better judgement of a company, not another one */
        if (g) { const n = judged; await save([g], model, sources, true); judged = n; web++; }
      } catch (e) { error = (e as Error).message; console.error("profile web", tenantId, error); }
    }));
  }
  return { judged, web, failed, ...(error ? { error } : {}) };
}
