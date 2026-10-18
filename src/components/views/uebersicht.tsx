"use client";
import { useEffect, useMemo, useState } from "react";
import { Icon, Top, api, pct, rate } from "../ui";
import type { Ctx } from "../types";

type Row = { d: string; sender: number | null; sent: number; rep: number; bounce: number; hub: number };
type Day = { d: Date; sent: number; rep: number; bounce: number; hub: number; by: Record<number, { sent: number; rep: number }> };
const DAY = 864e5;
const PERIODS: [string, string][] = [["7", "7 Tage"], ["30", "30 Tage"], ["90", "Quartal"], ["all", "Seit Start"]];
const fmtD = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("de-DE", o);
const sum = (a: Day[], k: "sent" | "rep" | "bounce" | "hub") => a.reduce((x, p) => x + p[k], 0);
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/* one point per day; n days back from today, or since the first sent mail */
function series(rows: Row[], n?: number): Day[] {
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const first = rows.length ? new Date(`${rows[0].d}T12:00:00`) : today;
  const start = n ? new Date(today.getTime() - (n - 1) * DAY) : new Date(Math.min(first.getTime(), today.getTime() - 6 * DAY));
  const map: Record<string, Day> = {};
  for (let d = new Date(start); d <= today; d = new Date(d.getTime() + DAY)) map[isoDay(d)] = { d, sent: 0, rep: 0, bounce: 0, hub: 0, by: {} };
  for (const r of rows) {
    const p = map[r.d]; if (!p) continue;
    p.sent += r.sent; p.rep += r.rep; p.bounce += r.bounce; p.hub += r.hub;
    const k = r.sender ?? 0; p.by[k] = p.by[k] || { sent: 0, rep: 0 }; p.by[k].sent += r.sent; p.by[k].rep += r.rep;
  }
  return Object.values(map);
}

function buckets(days: Day[]) {
  if (days.length <= 31) return days.map(p => ({ ...p, lbl: fmtD(p.d, { day: "2-digit", month: "2-digit" }), tip: fmtD(p.d, { weekday: "short", day: "2-digit", month: "2-digit" }) }));
  const out: { key: string; d: Date; sent: number; rep: number }[] = []; let cur: (typeof out)[number] | null = null;
  days.forEach(p => { const wd = (p.d.getDay() + 6) % 7, mon = new Date(p.d.getTime() - wd * DAY).toDateString();
    if (!cur || cur.key !== mon) { cur = { key: mon, d: p.d, sent: 0, rep: 0 }; out.push(cur); }
    cur.sent += p.sent; cur.rep += p.rep; });
  return out.map(b => ({ ...b, lbl: fmtD(b.d, { day: "2-digit", month: "2-digit" }), tip: `Woche ab ${fmtD(b.d, { day: "2-digit", month: "2-digit" })}` }));
}

function Chart({ b }: { b: { sent: number; rep: number; lbl: string; tip: string }[] }) {
  const W = 1040, H = 240, L = 30, R = 6, Tp = 8, B = 24, top = Math.max(4, Math.ceil(Math.max(0, ...b.map(x => x.sent)) / 4) * 4);
  const iw = W - L - R, ih = H - Tp - B, bw = iw / Math.max(b.length, 1), y = (v: number) => Tp + ih - v / top * ih, every = Math.ceil(b.length / 6);
  return <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Versand und Antworten">
    {[0, top / 4, top / 2, top * 3 / 4, top].map(v => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--line)" /><text x={L - 8} y={y(v) + 4} textAnchor="end">{v}</text></g>)}
    {b.map((p, i) => { const x = L + i * bw + bw * .18, w = bw * .64;
      return <g key={i}><title>{`${p.tip}: ${p.sent} gesendet, ${p.rep} Antworten`}</title><rect x={x} y={Tp} width={w} height={ih} fill="transparent" />
        {p.sent > 0 && <rect x={x} y={y(p.sent)} width={w} height={ih - (y(p.sent) - Tp)} rx="2.5" fill="var(--bar)" />}
        {p.rep > 0 && <rect x={x} y={y(p.rep)} width={w} height={ih - (y(p.rep) - Tp)} rx="2.5" fill="var(--accent)" />}
        {(b.length - 1 - i) % every === 0 && <text x={x + w / 2} y={H - 6} textAnchor="middle">{p.lbl}</text>}</g>; })}
  </svg>;
}

export function Uebersicht({ ctx }: { ctx: Ctx }) {
  const { st } = ctx, t = st.tenant!;
  const [rows, setRows] = useState<Row[] | null>(null), [tab, setTab] = useState("ueberblick"), [period, setPeriod] = useState("30");
  useEffect(() => { api<{ rows: Row[] }>(`/api/stats?t=${t.slug}`).then(r => setRows(r.rows)).catch(e => ctx.toast(e.message, { error: true })); }, [t.slug, ctx]);
  const all = useMemo(() => series(rows || []), [rows]);
  const days = useMemo(() => period === "all" ? all : series(rows || [], +period), [rows, all, period]);
  const hub = !!st.integ.hubspot?.on;

  function csv() {
    const lines = [["Datum", "Gesendet", "Antworten", "Unzustellbar", "Neu in HubSpot"].join(";"), ...(tab === "ueberblick" ? days : all).map(p => [isoDay(p.d), p.sent, p.rep, p.bounce, p.hub].join(";"))];
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" })); a.download = `outreach-${t.slug}.csv`; a.click();
  }

  return <>
    <Top title="Übersicht" onMenu={ctx.openSidebar}>
      {tab === "ueberblick" && <div className="seg">{PERIODS.map(([k, n]) => <button key={k} className={period === k ? "on" : ""} aria-pressed={period === k} onClick={() => setPeriod(k)}>{n}</button>)}</div>}
      <button className="btn sec" onClick={csv}><Icon n="download" /><span className="hide-m">Export</span></button>
    </Top>
    <div className="scroll"><div className="wrap">
      <div className="tabs"><button className={tab === "ueberblick" ? "on" : ""} onClick={() => setTab("ueberblick")}>Überblick</button><button className={tab === "monate" ? "on" : ""} onClick={() => setTab("monate")}>Nach Monat</button></div>
      {rows && (tab === "ueberblick" ? <Overview days={days} hub={hub} ctx={ctx} /> : <Months all={all} hub={hub} ctx={ctx} />)}
    </div></div>
  </>;
}

function Overview({ days, hub, ctx }: { days: Day[]; hub: boolean; ctx: Ctx }) {
  const { st } = ctx, sent = sum(days, "sent"), rep = sum(days, "rep"), t = st.templates;
  const active = t.filter(x => x.active), best = [...active].sort((a, b) => rate(b) - rate(a))[0]?.key, maxR = Math.max(0.0001, ...t.map(rate));
  const people = st.users.map(u => { const s = days.reduce((a, p) => a + (p.by[u.id]?.sent || 0), 0), r = days.reduce((a, p) => a + (p.by[u.id]?.rep || 0), 0); return [u.short, s, r] as const; });
  return <>
    <div className="kpis">
      <div className="kpi"><span className="l">Gesendet</span><span className="v">{sent.toLocaleString("de-DE")}</span></div>
      <div className="kpi"><span className="l">Antworten</span><span className="v">{rep.toLocaleString("de-DE")}</span></div>
      <div className="kpi"><span className="l">Antwortquote</span><span className="v">{sent ? pct(rep / sent * 100) : "–"}</span></div>
      <div className="kpi"><span className="l">{hub ? "Neu in HubSpot" : "Unzustellbar"}</span><span className="v">{(hub ? sum(days, "hub") : sum(days, "bounce")).toLocaleString("de-DE")}</span></div>
    </div>
    <div className="blk chart"><h3><span>Versand und Antworten</span><span className="legend"><span><i style={{ background: "var(--bar)" }} />Gesendet</span><span><i style={{ background: "var(--accent)" }} />Antworten</span></span></h3><Chart b={buckets(days)} /></div>
    <div className="split two">
      <div className="blk"><h3>A/B-Test<button className="btn gh" onClick={() => ctx.setView("vorlagen")}>Vorlagen<Icon n="arrow-right" /></button></h3>
        {t.map(x => <div key={x.key} className={`abrow ${x.key === best && x.sent ? "best" : ""}`}><span className="vc">{x.key}</span><span>{x.name}{!x.active && <> <span className="pill">Pausiert</span></>}</span>
          <span className="mono num">{x.sent ? pct(rate(x)) : "–"}</span><span className="track"><i style={{ width: `${rate(x) / maxR * 100}%` }} /></span></div>)}</div>
      <div className="blk"><h3>Nach Person</h3>
        <table><thead><tr><th>Person</th><th>Gesendet</th><th>Antworten</th><th>Quote</th></tr></thead><tbody>
          {people.map(([n, s, r]) => <tr key={n}><td><span className="cell">{n}</span></td><td className="num">{s}</td><td className="num">{r}</td><td className="num">{s ? pct(r / s * 100) : "–"}</td></tr>)}
        </tbody></table></div>
    </div>
  </>;
}

function Months({ all, hub, ctx }: { all: Day[]; hub: boolean; ctx: Ctx }) {
  const users = ctx.st.users;
  const m: Record<number, { d: Date; sent: number; rep: number; bounce: number; hub: number; by: Record<number, number> }> = {};
  all.forEach(p => { const k = p.d.getFullYear() * 12 + p.d.getMonth(); const x = (m[k] = m[k] || { d: p.d, sent: 0, rep: 0, bounce: 0, hub: 0, by: {} });
    x.sent += p.sent; x.rep += p.rep; x.bounce += p.bounce; x.hub += p.hub; for (const [u, v] of Object.entries(p.by)) x.by[+u] = (x.by[+u] || 0) + v.sent; });
  const rows = Object.values(m).reverse();
  const tot = rows.reduce((a, r) => { a.sent += r.sent; a.rep += r.rep; a.bounce += r.bounce; a.hub += r.hub; for (const [u, v] of Object.entries(r.by)) a.by[+u] = (a.by[+u] || 0) + v; return a; }, { d: new Date(), sent: 0, rep: 0, bounce: 0, hub: 0, by: {} as Record<number, number> });
  const tr = (r: typeof tot, label: React.ReactNode, bold?: boolean, k?: string) => <tr key={k} style={bold ? { fontWeight: 600 } : undefined}><td>{label}</td><td className="num">{r.sent}</td><td className="num">{r.rep}</td>
    <td className="num">{r.sent ? pct(r.rep / r.sent * 100) : "–"}</td>{users.map(u => <td key={u.id} className="num f2">{r.by[u.id] || 0}</td>)}<td className="num f2">{hub ? r.hub : r.bounce}</td></tr>;
  return <div className="tbl"><table><thead><tr><th>Monat</th><th>Gesendet</th><th>Antworten</th><th>Quote</th>{users.map(u => <th key={u.id}>{u.short}</th>)}<th>{hub ? "Neu in HubSpot" : "Unzustellbar"}</th></tr></thead><tbody>
    {rows.map((r, i) => tr(r, <>{fmtD(r.d, { month: "long", year: "numeric" })}</>, false, String(i)))}
    {tr(tot, "Gesamt", true, "tot")}
  </tbody></table></div>;
}
