import { words } from "./playbook";

/* Score of one rendered mail before it is approved: Jev's judgement minus the rules from 6,337 cold mails
   (under 100 words, subject under 30 characters, no link, one request). See lib/playbook.ts for the sources. */
export type Judgement = { reply: number; specific: number; easyAsk: number };
export type DraftText = { subject: string; body: string; hook: boolean };
export type DraftScore = { score: number; issues: string[]; expected?: number };

const LINK = /https?:\/\/\S+/g;

export function draftScore(j: Judgement, m: DraftText, cal?: ((score: number) => number) | null): DraftScore {
  let s = 70 * (j.reply / 4) + 15 * j.specific + 15 * j.easyAsk;
  const issues: string[] = [];
  const w = words(m.body.replace(LINK, ""));
  if (w > 100) { s -= 25; issues.push(`${w} Wörter`); }
  else if (w >= 80) { s -= 5; issues.push(`${w} Wörter`); }
  if (m.subject.length > 30) { s -= 10; issues.push(`Betreff ${m.subject.length} Zeichen`); }
  if (LINK.test(m.body)) { s -= 15; issues.push("Link im Text"); }
  LINK.lastIndex = 0;
  const q = (m.body.match(/\?/g) || []).length;
  if (q > 1) { s -= 5; issues.push(`${q} Fragen`); }
  if (!m.hook) { s -= 10; issues.push("Kein Anlass"); }
  if (j.specific < 0.5) issues.push("Nichts Konkretes zur Firma");
  if (j.easyAsk < 0.5) issues.push("Keine klare Bitte");
  const score = Math.max(0, Math.min(100, Math.round(s)));
  return cal ? { score, issues, expected: Math.round(cal(score) * 1000) / 1000 } : { score, issues };
}

const BANDS = [40, 60, 80];
const band = (score: number) => BANDS.filter(b => score >= b).length;

/* Expected reply rate per score band from mails that went out, shrunk towards the overall rate (10 pseudo-mails).
   Needs at least 30 sent mails and 3 replies; below that the score stays Jev's guess. */
export function calibrate(history: { score: number; replied: boolean }[]) {
  const replies = history.filter(h => h.replied).length;
  if (history.length < 30 || replies < 3) return null;
  const base = replies / history.length;
  const by = BANDS.map(() => ({ n: 0, r: 0 })).concat({ n: 0, r: 0 });
  for (const h of history) { const b = by[band(h.score)]; b.n++; if (h.replied) b.r++; }
  return (score: number) => { const b = by[band(score)]; return (b.r + 10 * base) / (b.n + 10); };
}

/* Reply rate of a template: its real sends and replies on top of a prior worth 20 sends,
   so Jev's guess (via the calibration) decides early and real replies take over */
export const expectedRate = (sent: number, replies: number, prior: number, k = 20) => (replies + k * prior) / (sent + k);

/* A template scored like a mail, with placeholders standing in for typical values */
export const templateText = (t: { subject: string; body: string }) => ({
  subject: t.subject.replace(/{{firma}}/g, "Firma GmbH").replace(/{{[a-z]+}}/g, "x"),
  body: t.body.replace(/{{ausschreibungen}}/g, "• Titel (Vergabestelle)").replace(/{{[a-z]+}}/g, "x"), hook: true,
});
