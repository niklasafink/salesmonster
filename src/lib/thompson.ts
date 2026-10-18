/* Marsaglia–Tsang; enough for Beta draws with integer counts */
function gamma(k: number): number {
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { const u1 = Math.random(), u2 = Math.random(); x = Math.sqrt(-2 * Math.log(u1 || 1e-12)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
    v = v ** 3; const u = Math.random();
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
const beta = (a: number, b: number) => { const x = gamma(a); return x / (x + gamma(b)); };

/* Thompson sampling: the variant whose sampled reply rate is highest. New variants get tried, better ones get more. */
export function thompson(stats: Record<string, { sent: number; replies: number }>) {
  return Object.entries(stats).map(([k, x]) => [k, beta(1 + x.replies, 1 + Math.max(0, x.sent - x.replies))] as const).sort((a, b) => b[1] - a[1])[0]?.[0];
}
