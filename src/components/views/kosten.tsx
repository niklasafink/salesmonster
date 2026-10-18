"use client";
import { useEffect, useMemo, useState } from "react";
import { Icon, api } from "../ui";
import type { Ctx } from "../types";

type Day = { d: string; cost: number };
type Action = { kind: string; at: string; items: number; calls: number; unpriced: number; cost: number };
type Period = "woche" | "monat" | "jahr";
type Bucket = { key: string; from: string; to: string; cost: number };

/* label, unit singular, unit plural */
const KINDS: Record<string, [string, string, string]> = {
  recherche: ["Recherche", "Entwurf", "Entwürfe"],
  runde: ["Recherche-Runde", "Lead", "Leads"],
  anreicherung: ["Anreicherung", "Kontakt", "Kontakte"],
  bewertung: ["Bewertung", "Lead", "Leads"],
  import: ["Import", "Kontakt", "Kontakte"],
  impressum: ["Impressum", "Firma", "Firmen"],
  signaturen: ["Kontakte aus E-Mails", "Signatur", "Signaturen"],
  einrichtung: ["Einrichtung", "Antwort", "Antworten"],
  texte: ["Mail-Texte", "Fassung", "Fassungen"],
  strecke: ["Strecke", "Variante", "Varianten"],
};
const VISIBLE = 15;

/* Days as YYYY-MM-DD in local time; the server sums by Berlin day */
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (s: string) => new Date(`${s}T12:00:00`);
const plus = (s: string, n: number) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };

function buckets(p: Period, off: number, today: string): Bucket[] {
  const now = parse(today);
  if (p === "woche") {
    /* Monday to Sunday */
    const mon = plus(today, -((now.getDay() + 6) % 7) - 7 * off);
    return Array.from({ length: 7 }, (_, i) => { const d = plus(mon, i); return { key: d, from: d, to: d, cost: 0 }; });
  }
  if (p === "monat") {
    const first = new Date(now.getFullYear(), now.getMonth() - off, 1, 12), n = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    return Array.from({ length: n }, (_, i) => { const d = plus(iso(first), i); return { key: d, from: d, to: d, cost: 0 }; });
  }
  const y = now.getFullYear() - off;
  return Array.from({ length: 12 }, (_, m) => ({ key: iso(new Date(y, m, 1, 12)), from: iso(new Date(y, m, 1, 12)), to: iso(new Date(y, m + 1, 0, 12)), cost: 0 }));
}

/* Costs arrive in millionths of a dollar; single actions often cost fractions of a cent */
function usd(micro: number) {
  const v = micro / 1e6;
  if (v > 0 && v < 0.0001) return "< 0,0001 $";
  const digits = v !== 0 && v < 1 ? 4 : 2;
  return v.toLocaleString("de-DE", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/* Even steps from zero; with no cost the axis reaches one cent */
function ticks(max: number) {
  const top = max > 0 ? max : 10_000, rough = top / 4, mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map(f => f * mag).find(v => v >= rough)!;
  return Array.from({ length: Math.ceil(top / step) + 1 }, (_, i) => i * step);
}

function axis(micro: number, step: number) {
  const s = step / 1e6, digits = s >= 1 ? 0 : s >= 0.01 ? 2 : s >= 0.001 ? 3 : 4;
  return (micro / 1e6).toLocaleString("de-DE", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function periodLabel(p: Period, b: Bucket[]) {
  const a = parse(b[0].from), z = parse(b[b.length - 1].to);
  if (p === "woche") return `${a.toLocaleDateString("de-DE", { day: "numeric", month: "short" })} – ${z.toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" })}`;
  if (p === "monat") return a.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
  return String(a.getFullYear());
}

/* a bar from the baseline with 4 px rounded top corners */
function bar(x: number, base: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h), top = base - h;
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
}

function Chart({ p, b }: { p: Period; b: Bucket[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const tk = ticks(Math.max(0, ...b.map(x => x.cost))), top = tk[tk.length - 1], step = tk[1] ?? top;
  const W = 720, H = 220, L = 62, R = 6, Tp = 8, B = 24, iw = W - L - R, ih = H - Tp - B, bw = iw / b.length;
  const y = (v: number) => Tp + ih - v / top * ih, gap = Math.min(bw * .3, 12);
  const lbl = (x: Bucket) => p === "jahr" ? parse(x.from).toLocaleDateString("de-DE", { month: "short" })
    : p === "woche" ? parse(x.from).toLocaleDateString("de-DE", { weekday: "short" }) : String(parse(x.from).getDate());
  const tip = (x: Bucket) => p === "jahr" ? parse(x.from).toLocaleDateString("de-DE", { month: "long", year: "numeric" }) : parse(x.from).toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "long" });
  const every = p === "monat" ? 5 : 1, h = hover !== null ? b[hover] : null;
  return <div className="cost-chart" onMouseLeave={() => setHover(null)}>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="KI-Kosten im Zeitraum">
      {tk.map(v => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--line)" /><text x={L - 8} y={y(v) + 4} textAnchor="end">{axis(v, step)}</text></g>)}
      {b.map((x, i) => { const bx = L + i * bw + gap / 2, w = bw - gap, bh = ih - (y(x.cost) - Tp);
        return <g key={x.key} onMouseEnter={() => setHover(i)}>
          <rect x={L + i * bw} y={Tp} width={bw} height={ih} fill={hover === i ? "var(--hover)" : "transparent"} />
          {x.cost > 0 && <path d={bar(bx, Tp + ih, w, Math.max(bh, 2))} fill="var(--accent)" />}
          {(p !== "monat" || i % every === 0 || i === b.length - 1) && <text x={L + i * bw + bw / 2} y={H - 6} textAnchor="middle">{lbl(x)}</text>}
        </g>; })}
    </svg>
    {h && <div className="tt" style={{ left: `${(L + (hover! + .5) * bw) / W * 100}%` }}><span className="f3">{tip(h)}</span><span className="num">{usd(h.cost)}</span></div>}
  </div>;
}

export function Kosten({ ctx }: { ctx: Ctx }) {
  const t = ctx.st.tenant!;
  const [data, setData] = useState<{ days: Day[]; actions: Action[] } | null>(null);
  const [p, setP] = useState<Period>("monat"), [off, setOff] = useState(0), [all, setAll] = useState(false);
  useEffect(() => { setData(null); api<{ days: Day[]; actions: Action[] }>(`/api/usage?t=${t.slug}`).then(setData).catch(e => ctx.toast((e as Error).message, { error: true })); }, [t.slug]); // eslint-disable-line react-hooks/exhaustive-deps
  const today = iso(new Date());
  const b = useMemo(() => {
    const list = buckets(p, off, today);
    for (const x of list) x.cost = (data?.days || []).reduce((s, d) => d.d >= x.from && d.d <= x.to ? s + d.cost : s, 0);
    return list;
  }, [p, off, today, data]);
  if (!data) return null;
  const from = b[0].from, to = b[b.length - 1].to;
  const total = b.reduce((s, x) => s + x.cost, 0), ever = data.days.reduce((s, d) => s + d.cost, 0);
  const inPeriod = data.actions.filter(a => { const d = iso(new Date(a.at)); return d >= from && d <= to; });
  const earliest = data.days[0]?.d ?? today, shown = all ? inPeriod : inPeriod.slice(0, VISIBLE);
  const unit = (a: Action) => { const k = KINDS[a.kind]; return a.items ? `${a.items.toLocaleString("de-DE")} ${k ? a.items === 1 ? k[1] : k[2] : ""}` : "–"; };
  const when = (s: string) => new Date(s).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const cost = (a: Action) => a.unpriced && !a.cost ? <span className="f3" title="Die Claude-API meldet keine Kosten">–</span> : usd(a.cost);

  return <>
    <div className="row3 cost-bar">
      <div className="seg" role="group" aria-label="Zeitraum">{([["woche", "Woche"], ["monat", "Monat"], ["jahr", "Jahr"]] as [Period, string][]).map(([k, n]) =>
        <button key={k} className={p === k ? "on" : ""} aria-pressed={p === k} onClick={() => { setP(k); setOff(0); setAll(false); }}>{n}</button>)}</div>
      <span className="sp" />
      <button className="btn gh ic" aria-label="Vorheriger Zeitraum" disabled={from <= earliest} onClick={() => { setOff(off + 1); setAll(false); }}><Icon n="arrow-left" /></button>
      <span className="num cost-per">{periodLabel(p, b)}</span>
      <button className="btn gh ic" aria-label="Nächster Zeitraum" disabled={off === 0} onClick={() => { setOff(off - 1); setAll(false); }}><Icon n="arrow-right" /></button>
    </div>
    <div className="kpis three">
      <div className="kpi"><span className="l">Im Zeitraum</span><span className="v">{usd(total)}</span></div>
      <div className="kpi"><span className="l">Aktionen</span><span className="v">{inPeriod.length.toLocaleString("de-DE")}</span></div>
      <div className="kpi"><span className="l">Insgesamt</span><span className="v">{usd(ever)}</span></div>
    </div>
    <div className="blk chart"><Chart p={p} b={b} /></div>
    {inPeriod.length > 0 && <div className="blk"><h3>Aktionen</h3><div className="tbl"><table className="costs"><thead><tr><th>Aktion</th><th>Umfang</th><th>Zeitpunkt</th><th className="num-r">Je Stück</th><th className="num-r">Kosten</th></tr></thead><tbody>
      {shown.map((a, i) => <tr key={i}><td>{KINDS[a.kind]?.[0] || a.kind}</td><td className="num f2">{unit(a)}</td><td className="num f2">{when(a.at)}</td>
        <td className="num f2 num-r">{a.items && a.cost ? usd(a.cost / a.items) : "–"}</td><td className="num num-r">{cost(a)}</td></tr>)}
    </tbody></table></div></div>}
    {inPeriod.length > VISIBLE && <div><button className="btn gh" onClick={() => setAll(!all)}>{all ? "Weniger anzeigen" : `Alle ${inPeriod.length} anzeigen`}</button></div>}
  </>;
}
