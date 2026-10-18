/* The lead fields a person may edit by hand */
export const LEAD_FIELDS = ["company", "salutation", "first", "last", "role", "email", "emailType", "phone", "linkedin", "website", "city", "hook", "note", "sourceUrl", "research"] as const;
export type LeadField = typeof LEAD_FIELDS[number];

export const SALUTATIONS = ["Herr", "Frau", "Herr Dr.", "Frau Dr.", "Herr Prof. Dr.", "Frau Prof. Dr."];

/* "Frau Dr." style salutation for {{anrede}}, or "" when neither Herr nor Frau is known */
export function salutationOf(raw: string) {
  const g = /\bfrau\b/i.test(raw) ? "Frau" : /\bherr\b/i.test(raw) ? "Herr" : "";
  if (!g) return "";
  return [g, /prof/i.test(raw) && "Prof.", /\bdr\b/i.test(raw) && "Dr."].filter(Boolean).join(" ");
}

/* Company mailboxes rather than a person's address */
export const INFO_MAIL = /^(info|kontakt|office|mail|post|service|vertrieb|hallo)@/i;
/* info = a company mailbox or no person to address; the rule for every place that writes email or name */
export const emailTypeOf = (email: string, person: boolean) => INFO_MAIL.test(email) || !person ? "info" : "person";
export const websiteOf = (w: string) => w && !/^https?:\/\//i.test(w) ? `https://${w}` : w;

export function cleanLead(b: Record<string, unknown>) {
  const out: Partial<Record<LeadField, string>> = {};
  for (const k of LEAD_FIELDS) if (typeof b[k] === "string") out[k] = (b[k] as string).trim().slice(0, k === "research" || k === "note" ? 4000 : 500);
  if (out.salutation !== undefined) out.salutation = salutationOf(out.salutation);
  if (out.emailType !== undefined && out.emailType !== "info") out.emailType = "person";
  return out;
}
