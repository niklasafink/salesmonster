import { and, count, desc, eq, like, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, leads, setups, templates, tenants, SETUP_STEPS, type ChatMsg, type SetupLead, type SetupStep, type StepSource } from "@/db";
import { ask, json } from "./claude";
import { AiMissing, type Ai } from "./ai";
import { getInteg } from "./integrations";
import { jevKey, scoreMail } from "./jev";
import { lint } from "./playbook";
import { rerate } from "./ratings";
import { skillFor, WEB } from "./skills";

type Tenant = typeof tenants.$inferSelect;
export type Setup = typeof setups.$inferSelect;

const s = () => z.string().nullish().transform(v => (v ?? "").trim());
const list = () => z.array(z.string()).nullish().transform(v => (v ?? []).map(x => x.trim()).filter(Boolean));
const Profile = z.object({ name: s(), summary: s(), offer: s(), valueProps: list(), customers: list(), proof: list(), regions: list(), language: s(), pricing: s(),
  audience: s(), goal: s(), ask: s(), giveaway: s(), alternatives: list(), objections: list(), rules: list(), words: list(), known: list() });
type ProfileOut = z.infer<typeof Profile>;

/* The model sometimes sends only what changed; empty fields keep the earlier value */
const mergeProfile = (prev: Setup["profile"], next: ProfileOut) => Object.fromEntries(Object.entries(next).map(([k, v]) =>
  [k, (Array.isArray(v) ? v.length : v) ? v : (prev as Record<string, unknown> | null)?.[k] ?? v])) as ProfileOut;
const Segment = z.object({ name: z.string().min(1), industries: list(), size: s(), regions: list(), triggers: list(), why: s(), exclude: list() });
const Persona = z.object({ role: z.string().min(1), titles: list(), segment: s(), pains: list(), goals: list(), query: s() });
const Lead = z.object({ company: z.string().min(2), website: s(), city: s(), segment: s(), person: s(), role: s(), linkedin: s(), email: s(), why: s(),
  vote: z.union([z.literal(1), z.literal(-1)]).nullish().transform(v => v ?? undefined), reason: s() });
const Tpl = z.object({ key: z.string().min(1), name: s(), tone: s(), subject: z.string().min(2), body: z.string().min(20) });
const Out = z.object({
  reply: z.string(), chips: z.array(z.string()).catch([]), advance: z.boolean().catch(false), site: s().catch(""),
  profile: Profile.nullish().catch(null), segments: z.array(Segment).nullish().catch(null), personas: z.array(Persona).nullish().catch(null),
  leads: z.array(Lead).nullish().catch(null), templates: z.array(Tpl).nullish().catch(null),
});

export async function loadSetup(tenantId: number): Promise<Setup> {
  const active = and(eq(setups.tenantId, tenantId), eq(setups.active, true));
  const [row] = await db.select().from(setups).where(active);
  if (row) return row;
  return (await db.insert(setups).values({ tenantId }).onConflictDoNothing().returning())[0] ?? (await db.select().from(setups).where(active))[0];
}

/* Starts the setup over; the current chat stays in the list. An untouched chat is reused instead of piling up empty ones */
export async function newSetup(tenantId: number, su: Setup): Promise<Setup> {
  if (!su.chat.length && !su.profile) return su;
  await db.update(setups).set({ active: false }).where(eq(setups.tenantId, tenantId));
  return loadSetup(tenantId);
}

export async function switchSetup(tenantId: number, id: number): Promise<Setup | null> {
  const [row] = await db.select({ id: setups.id }).from(setups).where(and(eq(setups.tenantId, tenantId), eq(setups.id, id)));
  if (!row) return null;
  await db.update(setups).set({ active: false }).where(and(eq(setups.tenantId, tenantId), ne(setups.id, id)));
  return (await db.update(setups).set({ active: true }).where(eq(setups.id, id)).returning())[0];
}

export type ChatItem = { id: number; at: string; step: SetupStep; done: boolean };

/* The chats of a tenant for the rail, newest first; empty ones are left out except the active one */
export async function listChats(tenantId: number): Promise<ChatItem[]> {
  const rows = await db.select({ id: setups.id, active: setups.active, at: setups.updatedAt, chat: setups.chat, step: setups.step, doneAt: setups.doneAt })
    .from(setups).where(eq(setups.tenantId, tenantId)).orderBy(desc(setups.updatedAt));
  return rows.filter(r => r.active || r.chat.length).map(r => ({ id: r.id, at: r.at.toISOString(), step: r.step, done: !!r.doneAt }));
}

async function save(id: number, set: Partial<typeof setups.$inferInsert>) {
  return (await db.update(setups).set({ ...set, updatedAt: new Date() }).where(eq(setups.id, id)).returning())[0];
}

const nextStep = (step: SetupStep) => SETUP_STEPS[Math.min(SETUP_STEPS.indexOf(step) + 1, SETUP_STEPS.length - 1)];

/* The website is read once; the notes stand in for it in every later answer, in every chat of the tenant */
const siteNotes = (t: Tenant) => t.settings.site?.domain === t.domain ? t.settings.site.notes : "";
const mustRead = (t: Tenant, step: SetupStep) => !!t.domain && !siteNotes(t) && !!WEB[step];

/* The question an answer belongs to: the heading of the AI message before it */
const askedBefore = (chat: ChatMsg[], i: number) => {
  for (let j = i - 1; j >= 0; j--) if (chat[j].role === "ai") return chat[j].text.match(/^###[ \t]+(.+)$/m)?.[1] ?? "";
  return "";
};

/* What the model sees besides the skill: the results so far, compact */
function context(t: Tenant, su: Setup) {
  const parts = [`Unternehmen: ${t.name}\nWebsite: ${t.domain ? `https://${t.domain}` : "keine"}`];
  const notes = siteNotes(t);
  if (notes) parts.push(`Website-Notizen (die Website ist bereits gelesen, rufe sie nicht noch einmal ab):\n${notes}`);
  if (su.profile) parts.push(`Profil:\n${JSON.stringify(su.profile)}`);
  if (su.step !== "website" && su.segments.length) parts.push(`Segmente:\n${JSON.stringify(su.segments)}`);
  if (["liste", "ansprache", "fertig"].includes(su.step) && su.personas.length) parts.push(`Ansprechpartner:\n${JSON.stringify(su.personas)}`);
  if (["liste", "ansprache"].includes(su.step) && su.leads.length) parts.push(`Leads mit Bewertung:\n${JSON.stringify(su.leads)}`);
  if (su.step === "ansprache" && su.templates.length) parts.push(`Aktuelle Mails:\n${JSON.stringify(su.templates.map(({ score, ...x }) => ({ ...x, jev: score?.weakness })))}`);
  if (su.skipped.length) parts.push(`Übersprungen: ${su.skipped.join(", ")}`);
  /* what the user said in other steps, so nothing has to be asked twice */
  const said = su.chat.map((m, i) => ({ m, q: askedBefore(su.chat, i) })).filter(({ m }) => m.role === "me" && m.step !== su.step).slice(-20);
  if (said.length) parts.push(`Aussagen des Nutzers aus früheren Schritten:\n${said.map(({ m, q }) => `- (${m.step}) ${q ? `auf „${q}“: ` : ""}${m.text}`).join("\n")}`);
  return parts.join("\n\n");
}

/* Writing mails needs the most care; the profile and segments decide everything after them */
const EFFORT: Record<SetupStep, "low" | "medium" | "high"> = { website: "medium", zielgruppe: "medium", ansprechpartner: "medium", liste: "medium", ansprache: "high", fertig: "low" };
/* Answering the user within a step is a chat turn: one level less thinking, so the reply starts sooner */
const LESS = { low: "low", medium: "low", high: "medium" } as const;

/* The "reply" string of the JSON block as far as it has streamed, decoded up to the last complete character */
export function partialReply(text: string) {
  const i = text.lastIndexOf('"reply"'), m = i < 0 ? null : /^"reply"\s*:\s*"/.exec(text.slice(i));
  if (!m) return "";
  let out = "";
  for (let j = i + m[0].length; j < text.length; j++) {
    const c = text[j];
    if (c === '"') break;
    if (c !== "\\") { out += c; continue; }
    const e = text[j + 1];
    if (e === undefined) break;
    if (e === "u") { const h = text.slice(j + 2, j + 6); if (h.length < 4) break; out += String.fromCharCode(parseInt(h, 16)); j += 5; continue; }
    out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[e] ?? e; j++;
  }
  return out;
}

/* One model call for the current step. text = what the user wrote; auto = decide alone; prev = the closing answer of the step just finished;
   onReply gets the reply so far while it streams */
async function think(t: Tenant, ai: Ai, su: Setup, text: string, auto: boolean, signal?: AbortSignal, prev?: string, onReply?: (reply: string) => void) {
  /* the buttons shown with each question go along, so the model knows which options the user did not pick */
  const history = su.chat.filter(m => m.step === su.step).slice(-12)
    .map(m => `${m.role === "ai" ? "Du" : "Nutzer"}: ${m.text}${m.role === "ai" && m.chips?.length ? `\n(Antwort-Buttons: ${m.chips.join(" | ")})` : ""}`).join("\n");
  const ask_ = auto ? "Der Nutzer möchte, dass du diesen Schritt ohne Rückfragen selbst erledigst. Triff alle Entscheidungen selbst, fülle die Felder vollständig und setze advance auf true."
    : text ? `Nutzer: ${text}`
    : prev ? `Der vorige Schritt ist gerade abgeschlossen. Deine Abschlussantwort dort, die der Nutzer nicht sieht:\n«${prev}»\nBeginne reply mit höchstens einem Satz, der den Abschluss bestätigt, ohne Frage. Dann beginne diesen Schritt: erledige die Recherche bzw. den Entwurf und stelle deine erste Frage.`
    : "Beginne diesen Schritt: erledige die Recherche bzw. den Entwurf und stelle dann deine erste Frage.";
  const read = mustRead(t, su.step);
  const readNote = read ? `\n\nDie Website https://${t.domain} ist noch nicht gelesen. Lies sie jetzt einmal gründlich und gib alles, was du dort gefunden hast, in "site" zurück. Diese Notizen werden gespeichert und ersetzen das Lesen der Website in allen folgenden Antworten.` : "";
  /* step 1 needs the web only to read the website; other steps search the market and get the notes instead of the site */
  const web = su.step === "website" ? read : !!WEB[su.step];
  const raw = await ask({
    key: ai, system: skillFor(su.step), web, maxSearches: web ? WEB[su.step] ?? 0 : 0, effort: text && !auto ? LESS[EFFORT[su.step]] : EFFORT[su.step], signal,
    onText: onReply && (raw => { const r = partialReply(raw); if (r) onReply(labelled(r, su.step)); }),
    prompt: `${context(t, su)}${history ? `\n\nBisheriger Verlauf in diesem Schritt:\n${history}` : ""}${readNote}\n\n${ask_}`,
  });
  return json(raw, Out);
}

/* Jev reviews each template once, rendered with the first good lead; optional */
async function scoreTemplates(t: Tenant, su: Setup, tpls: z.infer<typeof Tpl>[]) {
  const jev = await jevKey(t.id);
  const l = su.leads.find(x => x.vote === 1) || su.leads[0];
  const fill = (x: string) => x.replace(/{{anrede}}/g, l?.person ? `Guten Tag ${l.person},` : "Guten Tag,").replace(/{{firma}}/g, l?.company || "Muster GmbH")
    .replace(/{{vorname}}/g, l?.person.split(" ")[0] || "").replace(/{{nachname}}/g, l?.person.split(" ").slice(1).join(" ") || "")
    .replace(/{{aufhaenger}}/g, l?.why || "die neue Niederlassung").replace(/{{absender}}/g, t.name);
  return Promise.all(tpls.map(async x => {
    const score = jev ? await scoreMail(jev, { subject: fill(x.subject), body: fill(x.body), company: l?.company, role: l?.role }, { wait: false }).catch(() => null) : null;
    return { ...x, tone: x.tone === "du" ? "du" : "sie", score };
  }));
}

/* Each question heading names the step on the left it belongs to; when the model leaves it out, the current step is used */
const LABEL: Record<SetupStep, string> = { website: "Unternehmen", zielgruppe: "Zielgruppe", ansprechpartner: "Ansprechpartner", liste: "Erste Liste", ansprache: "Ansprache", fertig: "Übernehmen" };
const labelled = (reply: string, step: SetupStep) => reply.replace(/^###[ \t]+(.+)$/gm, (m, q: string) =>
  Object.values(LABEL).some(l => q.startsWith(`${l}:`)) ? m : `### ${LABEL[step]}: ${q}`);

export type Action = { action: "start" | "message" | "auto" | "next" | "skip" | "goto" | "votes" | "prompt"; text?: string; step?: SetupStep; leads?: SetupLead[]; intro?: ChatMsg[] };

/* Which step writes which prompt section, so an AI update replaces a hand edit */
const drop = (su: Setup, ...steps: SetupStep[]) => Object.fromEntries(Object.entries(su.prompts).filter(([k]) => !steps.includes(k as SetupStep) && k !== "fertig"));

/* signal: the user stopped the answer in the chat, nothing from this turn is saved. onReply: the answer so far while it streams, "" when a chained step starts over */
export async function act(t: Tenant, ai: Ai | null, su: Setup, a: Action, signal?: AbortSignal, onReply?: (reply: string) => void): Promise<Setup> {
  if (a.action === "goto") {
    if (!a.step || !SETUP_STEPS.includes(a.step)) return su;
    /* jumping ahead passes over the steps in between; those still empty count as skipped, the step jumped to is open again */
    const src = await stepSources(t.id, su), passed = SETUP_STEPS.slice(SETUP_STEPS.indexOf(su.step), SETUP_STEPS.indexOf(a.step)).filter(k => !src[k]);
    return save(su.id, { step: a.step, skipped: [...new Set([...su.skipped.filter(k => k !== a.step), ...passed])] });
  }
  if (a.action === "prompt") {
    if (!a.step || !SETUP_STEPS.includes(a.step)) return su;
    const text = (a.text || "").trim().slice(0, 20000), prompts = a.step === "fertig" ? { ...su.prompts } : drop(su, a.step);
    if (text) prompts[a.step] = text; else delete prompts[a.step];
    const sources = { ...su.sources };
    if (text) sources[a.step] = "nutzer"; else delete sources[a.step];
    return save(su.id, { prompts, sources });
  }
  if (a.action === "votes") return save(su.id, { leads: (a.leads ?? su.leads).map(l => Lead.parse(l)), prompts: drop(su, "liste"), sources: { ...su.sources, liste: "nutzer" } });
  if (a.action === "skip") return save(su.id, { step: nextStep(su.step), skipped: [...new Set([...su.skipped, su.step])] });
  if (a.action === "next") return save(su.id, { step: nextStep(su.step), skipped: su.skipped.filter(x => x !== su.step) });
  if (su.step === "fertig") return su;
  if (!ai) throw new AiMissing();

  const text = (a.text || "").trim().slice(0, 4000);
  if (a.action === "message" && !text) return su;
  const chat: ChatMsg[] = [...su.chat, ...(a.intro ?? [])];
  if (text) chat.push({ role: "me", text, step: su.step });

  const t0 = Date.now();
  let cur: Setup = su, step: SetupStep = su.step, reply: ChatMsg | null = null, prev = "";
  if (a.action === "message" && GO.test(text)) {
    /* "Weiter zur Zielgruppe" and the like change the step for sure; asking the model first only cost time and sometimes kept the step */
    step = nextStep(su.step);
    prev = su.chat.findLast(m => m.role === "ai" && m.step === su.step)?.text ?? "";
  } else {
    const o = await think(t, ai, { ...su, chat }, text, a.action === "auto", signal, undefined, onReply);
    if (signal?.aborted) return su;
    cur = { ...su, ...(await absorb(t, su, o, text)) };
    if (o.site && mustRead(t, su.step)) t = { ...t, settings: { ...t.settings, site: { domain: t.domain, notes: o.site.slice(0, 20000), at: new Date().toISOString() } } };
    reply = { role: "ai", text: labelled(o.reply, su.step), step: su.step, chips: o.chips.slice(0, 4) };
    prev = o.reply;
    if (a.action === "auto" || (o.advance && a.action === "message")) step = nextStep(su.step);
  }

  /* A finished step starts the next one in the same request, so the user gets one answer instead of a closing answer, a wait and a second answer.
     Without enough time left the closing answer is saved and the client starts the next step as before */
  const left = CHAIN_MS - (Date.now() - t0);
  if (step !== su.step && step !== "fertig" && left > CHAIN_MIN_MS) {
    const nsu = { ...cur, chat, step };
    try {
      const timeout = AbortSignal.timeout(left);
      onReply?.("");
      const o2 = await think(t, ai, nsu, "", false, signal ? AbortSignal.any([signal, timeout]) : timeout, prev, onReply);
      cur = { ...cur, ...(await absorb(t, nsu, o2, "")) };
      chat.push({ role: "ai", text: labelled(o2.reply, step), step, chips: o2.chips.slice(0, 4) });
      return save(su.id, { ...pick(cur), chat: chat.slice(-80), step });
    } catch (e) {
      if (signal?.aborted) return su;
      console.error("setup: next step not chained", e);
    }
  }
  if (reply) chat.push(reply);
  return save(su.id, { ...pick(cur), chat: chat.slice(-80), step });
}

/* The "Weiter zu …" chip the skills offer when a step is done */
const GO = /^weiter zu[rm]?\s+[\wäöüÄÖÜß -]{2,30}$/i;

/* Vercel stops the function at 300 s (maxDuration of /api/setup); the chained call gets what is left, minus room to save */
const CHAIN_MS = 270_000, CHAIN_MIN_MS = 90_000;

const pick = (su: Setup): Partial<typeof setups.$inferInsert> =>
  ({ profile: su.profile, segments: su.segments, personas: su.personas, leads: su.leads, templates: su.templates, prompts: su.prompts, sources: su.sources });

/* Writes the data fields of one answer: website notes into the tenant, the rest is returned for the setup row */
async function absorb(t: Tenant, su: Setup, o: z.infer<typeof Out>, text: string) {
  if (o.site && mustRead(t, su.step)) {
    const site = { domain: t.domain, notes: o.site.slice(0, 20000), at: new Date().toISOString() };
    await db.update(tenants).set({ settings: sql`${tenants.settings} || ${JSON.stringify({ site })}::jsonb` }).where(eq(tenants.id, t.id));
  }
  const set: Partial<Setup> = {};
  if (o.profile) set.profile = mergeProfile(su.profile, o.profile);
  if (o.segments?.length) set.segments = o.segments;
  if (o.personas?.length) set.personas = o.personas;
  if (o.leads?.length) {
    /* keep the user's votes for companies that stay on the list */
    const prev = new Map(su.leads.map(l => [l.company.toLowerCase(), l]));
    set.leads = o.leads.map(l => { const p = prev.get(l.company.toLowerCase()); return p?.vote ? { ...l, vote: p.vote, reason: p.reason } : { ...l, vote: undefined, reason: "" }; });
  }
  if (o.templates?.length) set.templates = await scoreTemplates(t, su, o.templates.slice(0, 3));
  const wrote = ([["website", o.profile], ["zielgruppe", o.segments?.length], ["ansprechpartner", o.personas?.length], ["liste", o.leads?.length], ["ansprache", o.templates?.length]] as const).filter(([, v]) => v).map(([k]) => k);
  if (wrote.length) {
    set.prompts = drop(su, ...wrote);
    /* written from the user's answer counts as input, on its own (start, auto) as AI */
    set.sources = { ...su.sources, ...Object.fromEntries(wrote.map(k => [k, text ? "nutzer" : "ki"])) };
  }
  return set;
}

/* The prompt the evening research reads, one section per step. Keeps the field lines the settings form edits. */
export const PROMPT_KEY: Partial<Record<SetupStep, string>> = { website: "Angebot", zielgruppe: "Branchen", ansprechpartner: "Rollen", liste: "Passende Beispiele", ansprache: "Ansprache" };

export function promptParts(t: Tenant, su: Setup): Record<SetupStep, string> {
  const p = su.profile, segs = su.segments, per = su.personas;
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].join(", ");
  const good = su.leads.filter(l => l.vote === 1), bad = su.leads.filter(l => l.vote === -1);
  const lines = (...xs: (string | number | false | undefined | null)[]) => xs.filter((x): x is string => typeof x === "string").join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const gen: Record<SetupStep, string> = {
    website: lines(
      `Du recherchierst jeden Abend ${t.settings.leadsPerDay} Ansprechpartner für ${t.name}${p?.summary ? `. ${p.summary}` : "."}`, "",
      p?.offer && `Angebot: ${p.offer}`,
      p?.valueProps.length && `Nutzen: ${p.valueProps.join("; ")}`,
      p?.audience && `Zielgruppe: ${p.audience}`,
      p?.goal && `Ziel: ${p.goal}`,
      p?.ask && `Bitte an den Empfänger: ${p.ask}${p.giveaway ? ` (Angebot: ${p.giveaway})` : ""}`,
      p?.words?.length && `Begriffe der Zielgruppe: ${p.words.join(", ")}`,
      p?.objections?.length && `Einwände: ${p.objections.join("; ")}`,
      p?.rules?.length && `Regeln:\n${p.rules.map(r => `- ${r}`).join("\n")}`,
      p?.known?.length && `Nie anschreiben: ${p.known.join(", ")}`),
    zielgruppe: lines(
      `Branchen: ${uniq(segs.flatMap(x => x.industries))}`,
      `Regionen: ${uniq(segs.flatMap(x => x.regions)) || uniq(p?.regions ?? []) || "Deutschland"}`,
      `Größe: ${uniq(segs.map(x => x.size))}`, "",
      segs.length && `Segmente, das beste zuerst:\n${segs.map(x => `- ${x.name}: ${x.why}${x.triggers.length ? ` Anlässe: ${x.triggers.join(", ")}.` : ""}${x.exclude.length ? ` Nicht: ${x.exclude.join(", ")}.` : ""}`).join("\n")}`),
    ansprechpartner: lines(
      `Rollen: ${uniq(per.map(x => x.role))}`, "",
      per.length && `Ansprechpartner:\n${per.map(x => `- ${x.role} (${x.titles.join(", ")}): ${x.pains.join("; ")}`).join("\n")}`),
    liste: lines(
      good.length && `Passende Beispiele: ${good.map(l => l.company + (l.reason ? ` (${l.reason})` : "")).join("; ")}`,
      bad.length && `Nicht passend: ${bad.map(l => l.company + (l.reason ? ` (${l.reason})` : "")).join("; ")}`),
    ansprache: lines(
      `Ansprache: ${p?.language === "du" ? "Du" : "Sie"}`,
      "Gib den Anlass als {{aufhaenger}} zurück, und zwar als Substantivgruppe im Nominativ, zum Beispiel „die neue Niederlassung in Halle“."),
    fertig: "",
  };
  const parts = { ...gen, ...su.prompts };
  const steps = SETUP_STEPS.filter(k => k !== "fertig");
  parts.fertig = su.prompts.fertig || lines(...steps.flatMap(k => [parts[k], ""]),
    "Personen findest du im Impressum (Geschäftsführung), auf Team- und Karriereseiten und über die Websuche nach öffentlichen LinkedIn-Profilen (site:linkedin.com/in \"Titel\" \"Firma\"). Melde dich nie bei LinkedIn an.",
    `Überspringe Unternehmen, die bereits in HubSpot stehen oder in den letzten ${t.settings.cooldownDays} Tagen angeschrieben wurden.`);
  return parts;
}

export type Sources = Partial<Record<SetupStep, StepSource>>;

/* Who filled each step, for the dots in the rail. Filled without a recorded source means it came from a research run (scripts/prefill.ts);
   leads and templates from such a run go straight into the tenant, so they count for their step too */
export async function stepSources(tenantId: number, su: Setup): Promise<Sources> {
  const [[l], [m]] = await Promise.all([
    db.select({ n: count() }).from(leads).where(and(eq(leads.tenantId, tenantId), like(leads.source, "Recherche%"))),
    db.select({ n: count() }).from(templates).where(and(eq(templates.tenantId, tenantId), eq(templates.origin, "Recherche"))),
  ]);
  const filled: Record<SetupStep, boolean> = { website: !!su.profile, zielgruppe: su.segments.length > 0, ansprechpartner: su.personas.length > 0,
    liste: su.leads.length > 0, ansprache: su.templates.length > 0, fertig: !!su.doneAt };
  const research: Partial<Record<SetupStep, boolean>> = { liste: l.n > 0, ansprache: m.n > 0 };
  return Object.fromEntries(SETUP_STEPS.flatMap(k => {
    const v = filled[k] ? su.sources[k] ?? "recherche" : research[k] ? "recherche" : undefined;
    return v ? [[k, v]] : [];
  }));
}

export const buildPrompt = (t: Tenant, su: Setup) => promptParts(t, su).fertig;

/* Writes the results into the tenant. Each part is opt-in on the last screen. */
export async function applySetup(t: Tenant, su: Setup, opts: { prompt?: string; templates?: boolean; leads?: boolean }) {
  const out = { prompt: false, templates: 0, leads: 0 };
  if (opts.prompt?.trim()) {
    await db.update(tenants).set({ settings: { ...t.settings, prompt: opts.prompt.trim() } }).where(eq(tenants.id, t.id));
    out.prompt = true;
  }
  if (opts.templates) {
    const required = ["{{anrede}}"];
    for (const x of su.templates.filter(x => !lint(x.subject, x.body, required).some(e => e.includes("unbekannt")))) {
      const v = { name: x.name || `Variante ${x.key}`, tone: x.tone, subject: x.subject, body: x.body, active: true, origin: "Einrichtung" };
      await db.insert(templates).values({ tenantId: t.id, key: x.key, ...v }).onConflictDoUpdate({ target: [templates.tenantId, templates.key], set: { ...v, score: null } });
      out.templates++;
    }
  }
  if (opts.leads) {
    const known = new Set((await db.select({ c: leads.company }).from(leads).where(eq(leads.tenantId, t.id))).map(r => r.c.toLowerCase()));
    for (const l of su.leads.filter(l => l.vote === 1 && !known.has(l.company.toLowerCase()))) {
      const [first, ...rest] = l.person.split(/\s+/);
      await db.insert(leads).values({ tenantId: t.id, company: l.company, city: l.city, website: l.website, first: first || "", last: rest.join(" "), role: l.role,
        email: l.email, linkedin: l.linkedin, hook: l.why, source: "Einrichtung", status: "neu" });
      out.leads++;
    }
    if (out.leads) await rerate(t.id);
  }
  await db.update(setups).set({ step: "fertig", doneAt: new Date(), sources: { ...su.sources, fertig: "nutzer" }, updatedAt: new Date() }).where(and(eq(setups.id, su.id)));
  return out;
}
