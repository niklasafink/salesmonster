import type { FitInfo, Tender } from "@/db/schema";

/* How good a lead is, as a score 0–100 with grade and reasons, and how likely it is to answer a cold mail.
   E[reply] = P(delivered) × P(reply | delivered); P(reply) is a sum of log-odds per feature on top of the tenant's base rate.
   Starting odds ratios come from public studies (Belkins 2025, Hunter, MadKudu, LeadMagic/gtm-skills icp-scoring, MIT);
   each feature value then learns from this tenant's own replies with a Beta prior worth 30 mails. See specs/lead-priorisierung/spec.md. */

export type RateLead = { status: string; email: string; emailType: string; first: string; last: string; salutation: string; role: string; linkedin: string;
  hook: string; tenders: Tender[]; fit: number | null; fitInfo?: FitInfo | null; vote: number; skips: number; source: string; angleId: number | null; createdAt: Date };
export type Outcome = { lead: RateLead; delivered: boolean; replied: boolean; bounced?: boolean };
export type Reason = { pts: number; text: string; learned?: boolean };
export type Part = "fit" | "reach" | "role" | "timing" | "feedback";
export type Rating = { rating: number | null; grade: "A" | "B" | "C" | "D" | null; expected: number; parts: Record<Part, number>; reasons: Reason[] };
type Stat = { n: number; r: number };
export type Model = { b0: number; base: number; stats: Record<string, Stat>; bounced: string[] };

const PRIOR = 0.04, K = 30, DAMP = 0.7, MIN_N = 30, MIN_R = 3;
const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export const FREEMAIL = /@(gmail|googlemail|gmx|web|t-online|outlook|hotmail|live|yahoo|icloud|me|posteo|aol|mail|freenet|online)\.[a-z.]+$/i;
/* role inboxes that reach a front desk, not a person (cf. reacherhq/check-if-email-exists roles list) */
const ROLE_BOX = /^(info|kontakt|contact|office|mail|post|service|vertrieb|sales|verkauf|buero|büro|zentrale|empfang|hello|hallo|team|anfrage|anfragen|support|marketing|presse|bewerbung|jobs|karriere|verwaltung|einkauf|auftrag|angebot|angebote|rechnung|buchhaltung|kanzlei|praxis|willkommen|noreply|no-reply)@/i;

export const domain = (email: string) => email.split("@")[1]?.toLowerCase() || "";

type Adr = "person" | "role" | "freemail" | "linkedin" | "none";
function address(l: RateLead): Adr {
  if (!l.email) return l.linkedin ? "linkedin" : "none";
  if (l.emailType === "info" || ROLE_BOX.test(l.email)) return "role";
  return FREEMAIL.test(l.email) ? "freemail" : "person";
}
/* Mail or LinkedIn: a personal address is the better way in, a front desk inbox, a bounced domain or no address at all lose to the profile */
export type Channel = { ch: "mail" | "linkedin" | "none"; text: string; manual?: boolean };
export function channelOf(l: { email: string; emailType: string; linkedin: string; channel?: string }, bounced: string[] = []): Channel {
  const li = /linkedin\.com\/in\//i.test(l.linkedin);
  if (l.channel === "linkedin" && li) return { ch: "linkedin", text: "Von Hand auf LinkedIn gesetzt", manual: true };
  if (l.channel === "mail" && l.email) return { ch: "mail", text: "Von Hand auf E-Mail gesetzt", manual: true };
  if (!l.email) return li ? { ch: "linkedin", text: "Keine E-Mail" } : { ch: "none", text: "Weder E-Mail noch LinkedIn" };
  if (!li) return { ch: "mail", text: "Kein LinkedIn-Profil" };
  if (bounced.includes(domain(l.email))) return { ch: "linkedin", text: "Domain unzustellbar" };
  const a = address({ email: l.email, emailType: l.emailType, linkedin: l.linkedin } as RateLead);
  return a === "role" ? { ch: "linkedin", text: "Nur Sammeladresse, LinkedIn erreicht die Person" } : { ch: "mail", text: a === "person" ? "Persönliche Adresse" : "Freemail-Adresse" };
}

const ADR: Record<Adr, { or: number; deliver: number; text: string }> = {
  person: { or: 1, deliver: 0.95, text: "Persönliche Adresse" },
  role: { or: 0.35, deliver: 0.9, text: "Sammeladresse" },
  freemail: { or: 0.8, deliver: 0.95, text: "Freemail-Adresse" },
  linkedin: { or: 0.5, deliver: 0.6, text: "Keine E-Mail, nur LinkedIn" },
  none: { or: 0.5, deliver: 0.1, text: "Keine E-Mail" },
};

type RoleGroup = "gf" | "lead" | "staff" | "unknown";
function roleGroup(role: string): RoleGroup {
  if (!role.trim()) return "unknown";
  if (/gesch[äa]ftsf|inhaber|owner|ceo|vorstand|gr[üu]nder|founder|managing director|gesellschafter|eigent[üu]mer/i.test(role)) return "gf";
  if (/leit|head|direct|direktor|chef|vp\b|vice president|cto|cfo|coo|cmo|prokur/i.test(role)) return "lead";
  return "staff";
}
const ROLE: Record<RoleGroup, { or: number; text: string }> = {
  gf: { or: 1.3, text: "Geschäftsführung" }, lead: { or: 1.1, text: "Leitung" }, staff: { or: 0.8, text: "Fachebene" }, unknown: { or: 0.7, text: "Rolle unbekannt" },
};

/* fit is the main axis (firmographics weigh 40 % in LeadMagic icp-scoring) and is not damped; 0 is close to a hard no */
const FIT_OR = [0.1, 0.5, 1, 1.3, 2];
const fitOr = (fit: number) => { const f = Math.max(0, Math.min(4, fit)), i = Math.min(3, Math.floor(f)); return FIT_OR[i] + (FIT_OR[i + 1] - FIT_OR[i]) * (f - i); };
const fitText = (fit: number) => fit >= 3.5 ? "Passt sehr gut" : fit >= 2.5 ? "Passt gut" : fit >= 1.5 ? "Passt teilweise" : "Passt kaum";

/* Deadline "TT.MM." in the year of `now`; a missing or unreadable one counts as open */
function open(t: Tender, now: Date) {
  const m = t.f?.match(/(\d{1,2})\.(\d{1,2})\.?(\d{2,4})?/);
  if (!m) return true;
  const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : now.getUTCFullYear();
  return new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1]), 23, 59)) >= now;
}

/* The feature values a lead is learned by */
function features(l: RateLead): { key: string; lnOr: number }[] {
  const out = [{ key: `adr:${address(l)}`, lnOr: Math.log(ADR[address(l)].or) }, { key: `role:${roleGroup(l.role)}`, lnOr: Math.log(ROLE[roleGroup(l.role)].or) }];
  if (l.fit !== null) out.push({ key: `fit:${Math.round(l.fit)}`, lnOr: Math.log(fitOr(l.fit)) });
  if (l.angleId !== null) out.push({ key: `angle:${l.angleId}`, lnOr: 0 });
  out.push({ key: `src:${l.source}`, lnOr: 0 });
  return out;
}

/* Counts per feature value from mails that went out (bounces only count against the domain) and from thumbs.
   A thumb is half an observation whose outcome is the base rate shifted by the thumb's odds ratio, so votes nudge but never outweigh replies. */
export function learnModel(history: Outcome[]): Model {
  const sent = history.filter(h => h.delivered);
  const N = sent.length, R = sent.filter(h => h.replied).length;
  const base = (R + K * PRIOR) / (N + K), b0 = logit(base);
  const stats: Record<string, Stat> = {};
  const add = (k: string, n: number, r: number) => { const s = stats[k] ||= { n: 0, r: 0 }; s.n += n; s.r += r; };
  for (const h of sent) for (const f of features(h.lead)) add(f.key, 1, h.replied ? 1 : 0);
  for (const h of history) if (h.lead.vote) {
    const p = sigmoid(b0 + Math.log(h.lead.vote > 0 ? 1.5 : 0.3));
    for (const f of features(h.lead)) add(f.key, 0.5, 0.5 * p);
  }
  const bounced = [...new Set(history.filter(h => h.bounced).map(h => domain(h.lead.email)).filter(Boolean))];
  return { b0, base, stats, bounced };
}

/* Learned log-odds of a feature value against the base rate; its prior is the starting odds ratio */
function weight(m: Model, key: string, lnOr: number) {
  const s = m.stats[key], p = sigmoid(m.b0 + lnOr);
  if (!s) return { w: lnOr, learned: false, n: 0 };
  return { w: logit((s.r + K * p) / (s.n + K)) - m.b0, learned: s.n >= MIN_N && s.r >= MIN_R, n: s.n };
}

const days = (a: Date, b: Date) => Math.max(0, Math.floor((b.getTime() - a.getTime()) / 864e5));

/* The score 0–100 is the AI's fit (lib/lead-fit.ts) times how reachable the person is, times trigger, thumbs and what replies taught us.
   `expected` stays the reply probability from the log-odds model above, for angles and strategy. Every lead is rated: until the AI has judged it,
   the fit counts as "teilweise" and the role stands in for the AI's view of the person. */
const REACH: Record<Adr, number> = { person: 1, freemail: 0.85, role: 0.6, linkedin: 0.55, none: 0.3 };

export function rateLead(l: RateLead, m: Model, now = new Date()): Rating {
  const parts: Record<Part, number> = { fit: 0, reach: 0, role: 0, timing: 0, feedback: 0 };
  const adr = address(l), rg = roleGroup(l.role), age = days(l.createdAt, now);
  const tenders = l.tenders.filter(t => open(t, now));

  /* reply probability, log-odds per feature on the tenant's base rate */
  let lo = 0;
  const odds = (lnOr: number, damp = true) => { lo += damp ? DAMP * lnOr : lnOr; };
  const wa = weight(m, `adr:${adr}`, Math.log(ADR[adr].or)); odds(wa.w);
  if (l.email && !l.last) odds(Math.log(0.7));
  const wr = weight(m, `role:${rg}`, Math.log(ROLE[rg].or)); odds(wr.w);
  if (l.fit !== null) odds(weight(m, `fit:${Math.round(l.fit)}`, Math.log(fitOr(l.fit))).w, false);
  const wg = l.angleId !== null ? weight(m, `angle:${l.angleId}`, 0) : null; if (wg) odds(wg.w);
  const ws = weight(m, `src:${l.source}`, 0); if (ws.learned) odds(ws.w);
  if (tenders.length) odds(Math.log(1 + 2 ** (-age / 14)), false); else if (l.hook) odds(Math.log(1 + 0.6 * 2 ** (-age / 30)), false);
  if (l.vote) odds(Math.log(l.vote > 0 ? 1.5 : 0.3), false);
  if (l.skips) odds(l.skips * Math.log(0.85), false);
  const bounced = !!l.email && m.bounced.includes(domain(l.email));
  const expected = Math.round(ADR[adr].deliver * (bounced ? 0.5 : 1) * sigmoid(m.b0 + lo) * 1000) / 1000;

  const reasons: Reason[] = [];
  const info = l.fit === null ? null : l.fitInfo;
  let score = 100 * Math.max(0, Math.min(4, l.fit ?? 2)) / 4;
  parts.fit = Math.round(score);
  if (l.fit === null) reasons.push({ pts: parts.fit, text: "Vorläufig, KI-Prüfung steht noch aus" });
  else if (info?.ko) reasons.push({ pts: -100, text: info.ko });
  else reasons.push({ pts: parts.fit, text: info?.why || fitText(l.fit) });
  /* each factor moves the score by a share of what it is at that point */
  const factor = (part: Part, k: number, text: string, learned = false) => {
    const d = score * (k - 1);
    score += d; parts[part] += Math.round(d);
    if (Math.abs(d) >= 0.5) reasons.push({ pts: Math.round(d), text, ...(learned ? { learned } : {}) });
  };
  /* how far replies moved a feature from its prior, trusted by the number of mails behind it */
  const lift = (w: { w: number; n: number }, prior: number) => Math.max(0.5, Math.min(2, Math.exp((w.w - prior) * w.n / (w.n + MIN_N))));
  if (l.fit === null) factor("role", ROLE[rg].or, ROLE[rg].text);
  if (REACH[adr] !== 1) factor("reach", REACH[adr], ADR[adr].text);
  factor("reach", lift(wa, Math.log(ADR[adr].or)), wa.w >= Math.log(ADR[adr].or) ? `${ADR[adr].text} antwortet gut` : `${ADR[adr].text} antwortet schlecht`, wa.learned);
  if (l.email && !l.last) factor("reach", 0.85, "Kein Name");
  if (bounced) factor("reach", 0.5, "Domain schon unzustellbar");
  if (wg) factor("fit", lift(wg, 0), wg.w >= 0 ? "Suchrichtung antwortet gut" : "Suchrichtung antwortet schlecht", wg.learned);
  if (ws.learned) factor("fit", lift(ws, 0), ws.w >= 0 ? `Quelle ${l.source} antwortet gut` : `Quelle ${l.source} antwortet schlecht`, true);
  /* the model already judged what the trigger says; its age adds a little urgency on top */
  if (tenders.length) factor("timing", 1 + 0.15 * 2 ** (-age / 14), `Ausschreibung, ${age === 1 ? "1 Tag" : `${age} Tage`} alt`);
  else if (l.hook) factor("timing", 1 + 0.05 * 2 ** (-age / 30), `Anlass, ${age === 1 ? "1 Tag" : `${age} Tage`} alt`);
  if (l.vote) factor("feedback", l.vote > 0 ? 1.2 : 0.5, l.vote > 0 ? "Daumen hoch" : "Daumen runter");
  if (l.skips) factor("feedback", 0.9 ** l.skips, l.skips === 1 ? "In der Freigabe übersprungen" : `${l.skips}× übersprungen`);

  const rating = Math.max(0, Math.min(100, Math.round(score)));
  return { rating, grade: rating >= 70 ? "A" : rating >= 50 ? "B" : rating >= 30 ? "C" : "D", expected, parts,
    reasons: [reasons[0], ...reasons.slice(1).sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts))] };
}
