import type { CompanyProfile, RatingInfo } from "@/db/schema";
import { FREEMAIL, ROLE_BOX, type Reason } from "./lead-rating";
import type { Rubric } from "./rubrics";

/* How much a company is worth as a customer and how warm the person is, 0–100:
   min(ceiling of the company type, size + fit + signals), size 0–60, fit 0–30, signals −10 to +25: the ideal company alone reaches 90,
   with what the person showed up to 100.
   The company part comes from the model's profile (lib/company-profile.ts), the person part from what the CRM knows.
   See specs/lead-priorisierung/bewertung-je-mandant.md. */

export type AccountLead = { email: string; emailType: string; role: string; stage: string; crmAt: Date | string | null; vote: number;
  /* registered on the website (CRM) rather than found by research */
  inbound: boolean;
  /* other people of the same company in the list */
  colleagues: number };
export type AccountRating = { rating: number | null; grade: RatingInfo["grade"] | null; parts: RatingInfo["parts"]; reasons: Reason[]; type: string; why: string };

const SIGNALS_MIN = -10, SIGNALS_MAX = 25, RECENT_DAYS = 14;
export const gradeOf = (n: number): RatingInfo["grade"] => n >= 70 ? "A" : n >= 50 ? "B" : n >= 30 ? "C" : "D";
const local = (email: string) => email.split("@")[0] || "";

/* what the person showed: a team mailbox, the HubSpot stage, colleagues, role, a fresh registration, the kind of address */
function personSignals(l: AccountLead, r: Rubric, now: Date): Reason[] {
  const out: Reason[] = [];
  const box = !!l.email && !!r.teamBox?.test(local(l.email));
  if (l.inbound && box) out.push({ pts: 15, text: r.teamBoxText || "Postfach des Fachteams" });
  if (l.stage === "opportunity") out.push({ pts: 12, text: "HubSpot: Opportunity" });
  if (l.colleagues > 0) out.push({ pts: Math.min(16, 8 + 4 * (l.colleagues - 1)), text: l.colleagues === 1 ? "Eine weitere Person der Firma" : `${l.colleagues} weitere Personen der Firma` });
  if (l.role && r.roles?.test(l.role)) out.push({ pts: 6, text: l.role });
  const at = l.crmAt ? new Date(l.crmAt) : null;
  if (l.inbound && at && (now.getTime() - at.getTime()) / 864e5 <= RECENT_DAYS) out.push({ pts: 4, text: "Frisch registriert" });
  if (l.email && FREEMAIL.test(l.email)) out.push({ pts: -10, text: "Freemail-Adresse" });
  else if (l.email && !box && !(l.emailType === "info" || ROLE_BOX.test(l.email))) out.push({ pts: 3, text: "Persönliche Firmenadresse" });
  return out;
}

export function rateAccount(p: CompanyProfile | null, l: AccountLead, r: Rubric, now = new Date()): AccountRating {
  const parts: RatingInfo["parts"] = { fit: 0, reach: 0, role: 0, timing: 0, feedback: 0 };
  if (l.stage === "customer") return { rating: null, grade: null, parts, reasons: [{ pts: 0, text: "Bestandskunde" }], type: "", why: "" };
  const type = p ? r.types.find(t => t.key === p.type) ?? r.types.find(t => t.key === "unklar")! : null;
  if (type && type.cap === null) return { rating: null, grade: null, parts, reasons: [{ pts: 0, text: type.label }], type: type.label, why: p?.why || "" };

  const reasons: Reason[] = [];
  let company: number;
  if (p) {
    const size = r.sizes.find(s => s.key === p.size), fit = r.fits.find(f => f.key === p.fit);
    company = (size?.pts ?? 0) + (fit?.pts ?? 0);
    if (size) reasons.push({ pts: size.pts, text: `${size.label}${p.employees ? ` (ca. ${p.employees.toLocaleString("de-DE")})` : ""}` });
    if (fit) reasons.push({ pts: fit.pts, text: fit.label });
  } else {
    /* not profiled yet: a middling company, so the person's signals still sort the list */
    company = 36;
    reasons.push({ pts: 36, text: "Vorläufig, Firma noch nicht geprüft" });
  }
  const sig = [...(p?.signals || []).map(k => r.signals.find(s => s.key === k)).filter((s): s is NonNullable<typeof s> => !!s).map(s => ({ pts: s.pts, text: s.label })),
    ...personSignals(l, r, now)];
  const signals = Math.max(SIGNALS_MIN, Math.min(SIGNALS_MAX, sig.reduce((a, s) => a + s.pts, 0)));
  reasons.push(...sig);

  let score = Math.max(0, company + signals);
  if (type?.cap != null && score > type.cap) {
    reasons.push({ pts: type.cap - score, text: `Höchstens ${type.cap}: ${type.label}` });
    score = type.cap;
  }
  if (l.vote) {
    const d = Math.round(score * (l.vote > 0 ? 0.2 : -0.5));
    score += d; parts.feedback = d;
    reasons.push({ pts: d, text: l.vote > 0 ? "Daumen hoch" : "Daumen runter" });
  }
  const rating = Math.max(0, Math.min(100, Math.round(score)));
  parts.fit = company; parts.reach = signals;
  return { rating, grade: gradeOf(rating), parts, type: type?.label || "", why: p?.why || "",
    reasons: reasons.filter(x => x.pts !== 0).sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts)) };
}
