/* Search directions of the research and how they compete. Each direction's success is its reply rate on top of a prior
   worth 20 mails, the prior being the mean expected reply rate of its leads (lib/lead-rating.ts, which already counts fit, thumbs and skips).
   Thompson sampling picks the directions for a round; every few rounds the AI adds new ones and the weakest AI-made one is paused. */

export type AngleStat = { id: number; origin: string; active: boolean; rounds: number; sent: number; replies: number; prior: number };
type Rng = () => number;

const K = 20, MAX_ACTIVE = 6, EVERY = 5, MIN_ROUNDS = 3;

export const angleScore = (a: AngleStat) => (a.replies + K * a.prior) / (a.sent + K);

/* Marsaglia–Tsang, with the k < 1 boost (G(k) = G(k+1)·U^(1/k)) since priors around 4 % give shapes below 1 */
function gamma(k: number, r: Rng): number {
  if (k < 1) return gamma(k + 1, r) * r() ** (1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { const u1 = r(), u2 = r(); x = Math.sqrt(-2 * Math.log(u1 || 1e-12)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
    v = v ** 3; const u = r();
    if (Math.log(u || 1e-12) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
export const beta = (a: number, b: number, r: Rng = Math.random) => { const x = gamma(a, r); return x / (x + gamma(b, r)); };

/* n distinct active directions, each the best of one Thompson draw among those left */
export function pickAngles<T extends AngleStat>(list: T[], n: number, r: Rng = Math.random): T[] {
  const left = list.filter(a => a.active), out: T[] = [];
  while (out.length < n && left.length) {
    const draws = left.map(a => beta(a.replies + K * a.prior, Math.max(0, a.sent - a.replies) + K * (1 - a.prior), r));
    out.push(left.splice(draws.indexOf(Math.max(...draws)), 1)[0]);
  }
  return out;
}

/* What to change after a round: new proposals every 5 rounds (or with fewer than 2 directions);
   above 6 active the weakest direction the AI made that had at least 3 rounds is paused. The user's own stay. */
export function rotation(list: AngleStat[], rounds: number) {
  const act = list.filter(a => a.active);
  const propose = act.length < 2 || (rounds > 0 && rounds % EVERY === 0);
  const cand = act.filter(a => a.origin !== "nutzer" && a.rounds >= MIN_ROUNDS).sort((x, y) => angleScore(x) - angleScore(y));
  return { propose, retire: act.length > MAX_ACTIVE && cand.length ? cand[0].id : null };
}

/* First directions: the industries listed in the research prompt ("Branchen: a, b; c"), else one general direction */
export function startAngles(prompt: string) {
  const m = prompt.match(/^Branchen:[ \t]*(.*)$/m);
  const list = (m?.[1] || "").split(/,|;/).map(s => s.trim()).filter(Boolean);
  return list.length ? list.slice(0, MAX_ACTIVE) : ["Allgemein"];
}

/* Whether a round is due in the half-hourly tick at Berlin `hour`: `perDay` spread evenly over 7–18 h, one per tick (one round fills
   the 5-minute limit). The window ends before the evening run at 19 or 20 h so both never research the same tenant at once. */
export function roundsDue(perDay: number, done: number, hour: number) {
  if (perDay <= 0 || hour < 7 || hour > 18) return 0;
  const target = Math.min(perDay, Math.ceil(perDay * (hour - 6) / 12));
  return target > done ? 1 : 0;
}
