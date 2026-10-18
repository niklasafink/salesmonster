import type { Tender } from "@/db/schema";

/* How likely a lead is to answer a cold mail, as a score 0–100 with grade and reasons.
   E[reply] = P(delivered) × P(reply | delivered); P(reply) is a sum of log-odds per feature on top of the tenant's base rate.
   Starting odds ratios come from public studies (Belkins 2025, Hunter, MadKudu, LeadMagic/gtm-skills icp-scoring, MIT);
   each feature value then learns from this tenant's own replies with a Beta prior worth 30 mails. See specs/lead-priorisierung/spec.md. */

export type RateLead = { status: string; email: string; emailType: string; first: string; last: string; salutation: string; role: string; linkedin: string;
  hook: string; tenders: Tender[]; fit: number | null; vote: number; skips: number; source: string; angleId: number | null; createdAt: Date };
export type Outcome = { lead: RateLead; delivered: boolean; replied: boolean; bounced?: boolean };
export type Reason = { pts: number; text: string; learned?: boolean };
export type Part = "fit" | "reach" | "role" | "timing" | "feedback";
export type Rating = { rating: number | null; grade: "A" | "B" | "C" | "D" | null; expected: number; parts: Record<Part, number>; reasons: Reason[] };
type Stat = { n: number; r: number };
export type Model = { b0: number; base: number; stats: Record<string, Stat>; bounced: string[] };

const PRIOR = 0.04, K = 30, DAMP = 0.7, MIN_N = 30, MIN_R = 3;
const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const pts = (lnOr: number) => Math.round(10 * lnOr / Math.LN2);

const UNRATED = new Set(["unzustellbar", "papierkorb", "dublette", "kontakt"]);
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
  if (!s) return { w: lnOr, learned: false };
  return { w: logit((s.r + K * p) / (s.n + K)) - m.b0, learned: s.n >= MIN_N && s.r >= MIN_R };
}

const days = (a: Date, b: Date) => Math.max(0, Math.floor((b.getTime() - a.getTime()) / 864e5));

export function rateLead(l: RateLead, m: Model, now = new Date()): Rating {
  const parts: Record<Part, number> = { fit: 0, reach: 0, role: 0, timing: 0, feedback: 0 };
  if (UNRATED.has(l.status)) return { rating: null, grade: null, expected: 0, parts, reasons: [] };
  /* nobody to write to: no mail and no LinkedIn means no chance of a reply */
  if (!l.email && !l.linkedin) return { rating: 0, grade: "D", expected: 0, parts, reasons: [{ pts: -50, text: "Keine E-Mail und kein LinkedIn" }] };
  const reasons: Reason[] = [];
  let lo = 0;
  const term = (part: Part, lnOr: number, text: string, learned = false, damp = true) => {
    const x = damp ? DAMP * lnOr : lnOr;
    lo += x; parts[part] += pts(x);
    if (Math.abs(pts(x)) >= 1) reasons.push({ pts: pts(x), text, ...(learned ? { learned } : {}) });
  };

  const adr = address(l), rg = roleGroup(l.role);
  const wa = weight(m, `adr:${adr}`, Math.log(ADR[adr].or)); term("reach", wa.w, ADR[adr].text, wa.learned);
  if (l.email && !l.last && adr !== "role") term("reach", Math.log(0.7), "Kein Name");
  if (adr === "role" && !l.last) term("reach", Math.log(0.7), "Kein Name");
  const wr = weight(m, `role:${rg}`, Math.log(ROLE[rg].or)); term("role", wr.w, ROLE[rg].text, wr.learned);
  if (l.fit !== null) { const wf = weight(m, `fit:${Math.round(l.fit)}`, Math.log(fitOr(l.fit))); term("fit", wf.w, fitText(l.fit), wf.learned, false); }
  if (l.angleId !== null) { const wg = weight(m, `angle:${l.angleId}`, 0); term("fit", wg.w, wg.w >= 0 ? "Suchrichtung antwortet gut" : "Suchrichtung antwortet schlecht", wg.learned); }
  const ws = weight(m, `src:${l.source}`, 0); if (ws.learned) term("fit", ws.w, ws.w >= 0 ? `Quelle ${l.source} antwortet gut` : `Quelle ${l.source} antwortet schlecht`, true);

  /* a reason to write now fades: tenders with a half-life of 14 days until their deadline, other news 30 days */
  const age = days(l.createdAt, now);
  const tenders = l.tenders.filter(t => open(t, now));
  if (tenders.length) term("timing", Math.log(1 + 2 ** (-age / 14)), `Ausschreibung, ${age === 1 ? "1 Tag" : `${age} Tage`} alt`, false, false);
  else if (l.hook) term("timing", Math.log(1 + 0.6 * 2 ** (-age / 30)), `Anlass, ${age === 1 ? "1 Tag" : `${age} Tage`} alt`, false, false);

  if (l.vote) term("feedback", Math.log(l.vote > 0 ? 1.5 : 0.3), l.vote > 0 ? "Daumen hoch" : "Daumen runter", false, false);
  if (l.skips) term("feedback", l.skips * Math.log(0.85), l.skips === 1 ? "In der Freigabe übersprungen" : `${l.skips}× übersprungen`, false, false);

  let deliver = ADR[adr].deliver;
  if (l.email && m.bounced.includes(domain(l.email))) { deliver *= 0.5; reasons.push({ pts: -10, text: "Domain schon unzustellbar" }); parts.reach -= 10; }
  const expected = deliver * sigmoid(m.b0 + lo);
  const rating = Math.max(0, Math.min(100, Math.round(50 + 10 * Math.log2(expected / PRIOR))));
  return { rating, grade: rating >= 60 ? "A" : rating >= 53 ? "B" : rating >= 45 ? "C" : "D", expected: Math.round(expected * 1000) / 1000, parts,
    reasons: reasons.sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts)) };
}
