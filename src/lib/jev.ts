import { createGateway, experimental_decide as decide, gateway } from "ai";
import type { MailScore } from "@/db/schema";
import { words } from "./playbook";

/* Jev (TypeSafe AI) answers typed questions with probabilities and never writes text.
   We use it as a cheap, fast judge for drafts; Claude does the writing. */
export const JEV = "typesafe-ai/jev";

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
    type: "boolean",
    instructions: "Does the email refer to something concrete about the recipient's company that would not fit any other company?",
  },
  easyAsk: {
    type: "boolean",
    instructions: "Does the email end with exactly one request the recipient can answer in one sentence?",
  },
  weakness: {
    type: "choice",
    instructions: "What would most likely keep the recipient from replying?",
    criteria: WEAK,
  },
} as const;

export class JevLimit extends Error {}

type Mail = { subject: string; body: string; company?: string; role?: string };

/* One mail, one call. wait=false gives up at the first 429 instead of sleeping. */
export async function scoreMail(key: string, m: Mail, { wait = true } = {}): Promise<MailScore> {
  /* empty key: fall back to the Vercel login (VERCEL_OIDC_TOKEN from `vercel env pull`) */
  const model = (key ? createGateway({ apiKey: key }) : gateway).decisionModel(JEV);
  const head = m.company ? `Recipient: ${m.role ? `${m.role} at ` : ""}${m.company}\n` : "";
  const state = `${head}Subject: ${m.subject}\n\n${m.body}`;
  const run = () => decide({ model, state, questions: QUESTIONS, maxRetries: 1 });

  let r: Awaited<ReturnType<typeof run>>;
  try { r = await run(); } catch (e) {
    const err = e as { statusCode?: number; responseHeaders?: Record<string, string> };
    if (err.statusCode !== 429) throw e;
    const after = Number(err.responseHeaders?.["retry-after"] ?? 60) * 1000;
    if (!wait || after > 120_000) throw new JevLimit("Jev-Kontingent erschöpft. Im kostenlosen Tarif sind es 5 Aufrufe je 5 Minuten, mit Guthaben im AI Gateway entfällt die Grenze.");
    await new Promise(res => setTimeout(res, after));
    r = await run();
  }

  const a = r.answers;
  /* expected level 0–4 when Jev returns per-level probabilities keyed by index */
  const probs = Object.entries(a.reply.probabilities ?? {});
  const reply = probs.length && probs.every(([k]) => /^\d+$/.test(k))
    ? probs.reduce((s, [k, p]) => s + Number(k) * p, 0) : a.reply.score;
  return {
    reply: Math.round(reply * 100) / 100,
    specific: Math.round(a.specific.probability * 100) / 100,
    easyAsk: Math.round(a.easyAsk.probability * 100) / 100,
    weakness: a.weakness.choice,
    words: words(m.body),
    subjectLen: m.subject.length,
  };
}

const SAL = { herr: "A man, addressed as Herr", frau: "A woman, addressed as Frau", unklar: "Cannot tell from name and role" } as const;

/* Herr or Frau from first name and role (e.g. "Geschäftsführerin"), up to 25 people per call.
   Only answers Jev is at least 90 % sure of; everything else stays "". */
export async function guessSalutations(key: string, people: { first: string; last: string; role: string }[]): Promise<("" | "Herr" | "Frau")[]> {
  const model = (key ? createGateway({ apiKey: key }) : gateway).decisionModel(JEV);
  const out: ("" | "Herr" | "Frau")[] = people.map(() => "");
  for (let i = 0; i < people.length; i += 25) {
    const chunk = people.slice(i, i + 25);
    const questions = Object.fromEntries(chunk.map((p, k) => [`p${k}`, {
      type: "choice" as const, criteria: SAL,
      instructions: `German business contact: ${[p.first, p.last].filter(Boolean).join(" ")}${p.role ? `, role "${p.role}"` : ""}. How is this person addressed in a German business letter?`,
    }]));
    const r = await decide({ model, state: "Salutation of German business contacts for a cold email.", questions, maxRetries: 1 });
    chunk.forEach((_, k) => {
      const a = r.answers[`p${k}`];
      const sure = a.probabilities ? (a.probabilities[a.choice] ?? 0) >= 0.9 : false;
      if (sure && a.choice !== "unklar") out[i + k] = a.choice === "frau" ? "Frau" : "Herr";
    });
  }
  return out;
}
