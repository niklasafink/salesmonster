import type { MailScore } from "@/db/schema";
import { getInteg } from "./integrations";
import type { Field } from "./lead-columns";
import { words } from "./playbook";

/* Jev (TypeSafe AI) answers typed questions with probabilities and never writes text.
   We use it as a cheap, fast judge for drafts; Claude does the writing. Runs on the OpenRouter key. */
export const JEV = "~typesafe/jev-latest";

export const jevKey = async (tenantId: number, userId?: number) => (await getInteg(tenantId, "openrouter", userId))?.key as string | undefined;

const WEAK = {
  long: "Too long or too dense for a first contact.",
  generic: "Could have been sent to any company; nothing specific to the recipient.",
  value: "Unclear what the recipient gains.",
  self: "Mostly talks about the sender.",
  ask: "The request is too big for a first contact (meeting, demo, call) or there is no clear request.",
  spam: "Reads like a mass mailing or advertising.",
  none: "No clear weakness.",
} as const;

const QUESTIONS = {
  reply: {
    type: "score",
    instructions: "This is a German B2B cold email to a mid-sized company. How likely is the recipient to reply?",
    criteria: ["Deleted or marked as spam", "Ignored", "Might reply", "Likely to reply", "Very likely: short, specific and easy to answer"],
  },
  specific: {
    type: "noul",
    instructions: "Does the email refer to something concrete about the recipient's company that would not fit any other company?",
  },
  easyAsk: {
    type: "noul",
    instructions: "Does the email end with exactly one request the recipient can answer in one sentence?",
  },
  weakness: {
    type: "choice",
    instructions: "What would most likely keep the recipient from replying?",
    criteria: WEAK,
  },
} satisfies Record<string, Question>;

export class JevLimit extends Error {}

type Question = { type: "choice"; instructions: string; criteria: Record<string, string> } | { type: "score"; instructions: string; criteria: readonly string[] } | { type: "noul"; instructions: string };
type Answer = { type: "choice"; choice: string; probabilities?: Record<string, number> } | { type: "score"; score: number } | { type: "noul"; noul: number };

/* POST /api/alpha/decisions; wait=false gives up at the first 429 instead of sleeping */
async function decide(key: string, state: string, questions: Record<string, Question>, wait: boolean): Promise<Record<string, Answer>> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "Sales Portal", "http-referer": "https://sales-portal-sooty.vercel.app" },
      body: JSON.stringify({ model: JEV, state, questions }),
    });
    const j = await r.json().catch(() => ({})) as { answers?: Record<string, Answer>; error?: { message?: string } };
    if (r.ok && j.answers) return j.answers;
    if (r.status === 429) {
      const after = Number(r.headers.get("retry-after") ?? 30) * 1000;
      if (!wait || attempt || after > 120_000) throw new JevLimit("Jev-Kontingent bei OpenRouter erschöpft");
      await new Promise(res => setTimeout(res, after));
      continue;
    }
    if (r.status >= 500 && !attempt) { await new Promise(res => setTimeout(res, 1500)); continue; }
    throw new Error(`Jev: ${j.error?.message || r.status}`);
  }
}

const pick = <T extends Answer["type"]>(a: Answer | undefined, t: T) => {
  if (a?.type !== t) throw new Error("Jev: unerwartete Antwort");
  return a as Extract<Answer, { type: T }>;
};

type Mail = { subject: string; body: string; company?: string; role?: string };

export async function scoreMail(key: string, m: Mail, { wait = true } = {}): Promise<MailScore> {
  const head = m.company ? `Recipient: ${m.role ? `${m.role} at ` : ""}${m.company}\n` : "";
  const a = await decide(key, `${head}Subject: ${m.subject}\n\n${m.body}`, QUESTIONS, wait);
  const reply = pick(a.reply, "score").score;
  return {
    reply: Math.round(reply * 100) / 100,
    specific: Math.round(pick(a.specific, "noul").noul * 100) / 100,
    easyAsk: Math.round(pick(a.easyAsk, "noul").noul * 100) / 100,
    weakness: pick(a.weakness, "choice").choice,
    words: words(m.body),
    subjectLen: m.subject.length,
  };
}

const SAL = { herr: "A man, addressed as Herr", frau: "A woman, addressed as Frau", unklar: "Cannot tell from name and role" } as const;

/* Herr or Frau from first name and role (e.g. "Geschäftsführerin"), up to 25 people per call.
   Only answers Jev is at least 90 % sure of; everything else stays "". */
export async function guessSalutations(key: string, people: { first: string; last: string; role: string }[]): Promise<("" | "Herr" | "Frau")[]> {
  const out: ("" | "Herr" | "Frau")[] = people.map(() => "");
  for (let i = 0; i < people.length; i += 25) {
    const chunk = people.slice(i, i + 25);
    const questions: Record<string, Question> = Object.fromEntries(chunk.map((p, k) => [`p${k}`, {
      type: "choice" as const, criteria: { ...SAL },
      instructions: `German business contact: ${[p.first, p.last].filter(Boolean).join(" ")}${p.role ? `, role "${p.role}"` : ""}. How is this person addressed in a German business letter?`,
    }]));
    const r = await decide(key, "Salutation of German business contacts for a cold email.", questions, true);
    chunk.forEach((_, k) => {
      const a = pick(r[`p${k}`], "choice");
      const sure = a.probabilities ? (a.probabilities[a.choice] ?? 0) >= 0.9 : false;
      if (sure && a.choice !== "unklar") out[i + k] = a.choice === "frau" ? "Frau" : "Herr";
    });
  }
  return out;
}

const COLS = {
  co: "Company or organisation name",
  sal: "Salutation or academic title of the contact person (Herr, Frau, Dr.)",
  first: "First name of the contact person",
  last: "Last name of the contact person",
  name: "Full name of the contact person",
  role: "Job title or role of the contact person",
  email: "Email address",
  web: "Company website or domain",
  city: "City or location of the company",
  li: "LinkedIn profile URL",
  hook: "Note on why to contact the company now (project, tender, news, expansion)",
  url: "Link to the source the lead was found in",
  note: "Short side fact about the person worth knowing before writing: department, area of responsibility, topic, committee",
  skip: "Anything else: phone, street, zip, IDs, dates, numbers, status, revenue, category, rating, short codes like A, B or R1, internal notes, empty. When in doubt, skip",
} as const;

/* Which CRM field each table column holds, judged from header and sample values, 25 columns per call.
   Below 60 % certainty the column stays "" and the user decides in the review step. */
export async function guessColumns(key: string, cols: { head: string; samples: string[] }[]): Promise<(Field | null)[]> {
  const out: (Field | null)[] = cols.map(() => null);
  for (let i = 0; i < cols.length; i += 25) {
    const chunk = cols.slice(i, i + 25);
    const questions: Record<string, Question> = Object.fromEntries(chunk.map((c, k) => [`c${k}`, {
      type: "choice" as const, criteria: { ...COLS },
      instructions: `Column "${c.head}"${c.samples.length ? ` with values ${c.samples.map(s => JSON.stringify(s)).join(", ")}` : " (empty)"}. Which CRM field does this column hold?`,
    }]));
    const r = await decide(key, "Columns of a German B2B lead list (Excel or CSV) imported into a sales CRM. Map each column to a contact field. Only columns a salesperson needs to write to the contact; everything else is skip.", questions, true);
    chunk.forEach((_, k) => {
      const a = pick(r[`c${k}`], "choice");
      const p = a.probabilities?.[a.choice] ?? 0;
      out[i + k] = p < 0.6 ? null : a.choice === "skip" ? "" : a.choice as Field;
    });
  }
  return out;
}
