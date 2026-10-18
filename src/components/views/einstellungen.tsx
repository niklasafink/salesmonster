"use client";
import { useState } from "react";
import { INTEG } from "@/lib/integ-meta";
import { Icon, Top, api, useEscape } from "../ui";
import type { Ctx } from "../types";

const FIELDS = ["Rollen", "Branchen", "Regionen", "Größe"];
const fieldRe = (f: string) => new RegExp("^" + f + ":[ \\t]*(.*)$", "m");
const getField = (p: string, f: string) => { const m = p.match(fieldRe(f)); return m ? m[1] : ""; };
const setField = (p: string, f: string, v: string) => fieldRe(f).test(p) ? p.replace(fieldRe(f), () => `${f}: ${v}`) : `${p.trimEnd()}\n${f}: ${v}`;
const when = (s: string) => new Date(s).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function Einstellungen({ ctx }: { ctx: Ctx }) {
  const t = ctx.st.tenant!;
  const [tab, setTab] = useState("zielgruppe");
  const tabs: [string, string][] = [["zielgruppe", "Zielgruppe"], ["ablauf", "Ablauf"], ["integrationen", "Integrationen"], ...(t.invoice ? [["rechnungen", "Rechnungen"] as [string, string]] : [])];
  return <>
    <Top title="Einstellungen" onMenu={ctx.openSidebar} />
    <div className="scroll"><div className="wrap narrow">
      <div className="tabs">{tabs.map(([k, n]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{n}</button>)}</div>
      {tab === "zielgruppe" ? <Ziel ctx={ctx} /> : tab === "ablauf" ? <Ablauf ctx={ctx} /> : tab === "integrationen" ? <Integ ctx={ctx} /> : <Billing ctx={ctx} />}
    </div></div>
  </>;
}

function Ziel({ ctx }: { ctx: Ctx }) {
  const t = ctx.st.tenant!;
  const [p, setP] = useState(t.settings.prompt);
  async function save() {
    try { await api(`/api/tenants/${t.slug}`, { method: "PATCH", body: { settings: { prompt: p } } }); ctx.toast("Gespeichert"); ctx.reload(); } catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }
  return <>
    <div className="form">{FIELDS.map(f => <label key={f} className="fld"><span>{f}</span><input className="inp" value={getField(p, f)} onChange={e => setP(setField(p, f, e.target.value))} /></label>)}</div>
    <label className="fld"><span>System-Prompt</span><textarea className="prompt" value={p} onChange={e => setP(e.target.value)} /></label>
    <label className="row2 list-box" style={{ minHeight: 44 }}><span>Ausschreibungen je Lead suchen</span>
      <button className={`sw ${t.tenders ? "on" : ""}`} aria-label="Ausschreibungen" onClick={async e => { e.preventDefault(); await api(`/api/tenants/${t.slug}`, { method: "PATCH", body: { tenders: !t.tenders } }); ctx.reload(); }} /></label>
    <div className="row3"><button className="btn" onClick={save}>Speichern</button><button className="btn sec" onClick={() => ctx.setView("einrichtung")}><Icon n="sparkles" />Mit KI einrichten</button></div>
  </>;
}

function Ablauf({ ctx }: { ctx: Ctx }) {
  const t = ctx.st.tenant!;
  const [n, setN] = useState(String(t.settings.leadsPerDay)), [busy, setBusy] = useState<string | null>(null);
  /* same bounds as the server: whole numbers 1..30 */
  const clampN = (v: string) => v.trim() && Number.isFinite(Number(v)) ? Math.max(1, Math.min(30, Math.round(Number(v)))) : null;
  async function saveN(v: string) {
    setN(v); const c = clampN(v); if (c === null) return;
    try { await api(`/api/tenants/${t.slug}`, { method: "PATCH", body: { settings: { leadsPerDay: c } } }); ctx.reload(); } catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }
  async function run(job: "research" | "send") {
    setBusy(job);
    try {
      const r = await api<{ created?: number; sent?: number; failed?: number }>("/api/run", { body: { t: t.slug, job } });
      ctx.toast(job === "research" ? `${r.created ?? 0} Entwürfe erstellt` : `${r.sent ?? 0} gesendet${r.failed ? `, ${r.failed} fehlgeschlagen` : ""}`);
      ctx.reload();
    } catch (e) { ctx.toast((e as Error).message, { error: true }); }
    setBusy(null);
  }
  return <>
    <div className="list-box">
      <label className="row2"><span>Leads pro Tag</span><input className="inp num" type="number" min={1} max={30} step={1} value={n} onChange={e => saveN(e.target.value)} onBlur={() => setN(String(clampN(n) ?? t.settings.leadsPerDay))} /></label>
      <div className="row2"><span>Recherche und Freigabe-Mail</span><span className="num f2">So–Do 20:00</span></div>
      <div className="row2"><span>Versand</span><span className="num f2">Mo–Fr 08:00</span></div>
    </div>
    <div className="row3">
      <button className="btn sec" onClick={() => run("research")} disabled={!!busy}>{busy === "research" && <Icon n="loader" />}Jetzt recherchieren</button>
      <button className="btn sec" onClick={() => run("send")} disabled={!!busy}><Icon n={busy === "send" ? "loader" : "send"} />Freigegebene jetzt senden</button>
    </div>
    {ctx.st.runs.length > 0 && <div className="list-box runs">{ctx.st.runs.map(r => <div key={r.id} className="row2">
      <span>{({ research: "Recherche", send: "Versand", enrich: "Ergänzung" } as Record<string, string>)[r.kind] || r.kind} <span className="f3 num">{when(r.createdAt)}</span></span>
      <span className={r.ok ? "f2" : ""} style={r.ok ? undefined : { color: "var(--r)" }}>{r.info}</span></div>)}</div>}
  </>;
}

function Integ({ ctx }: { ctx: Ctx }) {
  const { st } = ctx, t = st.tenant!;
  const [dlg, setDlg] = useState<string | null>(null), [vals, setVals] = useState<Record<string, string>>({}), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const x = INTEG.find(i => i.k === dlg);
  function open(k: string) {
    const m = INTEG.find(i => i.k === k)!;
    if (m.auth === "oauth") {
      if (!st.msConfigured) { ctx.toast("Microsoft-App fehlt: MS_CLIENT_ID und MS_CLIENT_SECRET in Vercel hinterlegen"); return; }
      location.href = `/api/integrations/microsoft?t=${t.slug}`; return;
    }
    setVals(Object.fromEntries((m.fields || []).map(f => [f.id, f.id === "user" ? st.me.email : f.value || ""]))); setErr(""); setDlg(k);
  }
  async function connect(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    try { await api("/api/integrations", { body: { t: t.slug, kind: dlg, values: vals } }); ctx.toast(`${x!.name} verbunden`); setDlg(null); ctx.reload(); }
    catch (e2) { setErr((e2 as Error).message); }
    setBusy(false);
  }
  useEscape(() => setDlg(null));
  async function disconnect(k: string) {
    try { await api(`/api/integrations?t=${t.slug}&kind=${k}`, { method: "DELETE" }); ctx.reload(); } catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }
  return <>
    <div className="list-box">{INTEG.map(i => { const s = st.integ[i.k];
      return <div key={i.k} className="row2 int"><span className="nm"><Icon n={i.ico} />{i.name}{s?.on ? <span className="pill g">Verbunden</span> : i.auth === "pending" ? <span className="pill">Demnächst</span> : null}
</span>
        {s?.on ? <button className="btn gh act" onClick={() => disconnect(i.k)}>Trennen</button> : i.auth === "pending" ? null : <button className="btn sec" onClick={() => open(i.k)}>Verbinden</button>}</div>; })}</div>
    {x && <div className="ov" onClick={e => e.target === e.currentTarget && setDlg(null)}><form className="dlg" role="dialog" aria-modal="true" aria-label={`${x.name} verbinden`} onSubmit={connect}>
      <div className="dlg-h">{x.name} verbinden<button type="button" className="btn gh ic" onClick={() => setDlg(null)} aria-label="Schließen"><Icon n="x" /></button></div>
      {x.fields!.map((f, i) => <label key={f.id} className="fld"><span>{f.label}</span>{f.options
        ? <select className="inp" value={vals[f.id] || ""} onChange={e => setVals({ ...vals, [f.id]: e.target.value })}>{f.options.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
        : <input className="inp" type={f.type || "text"} value={vals[f.id] || ""} autoFocus={i === 0} autoComplete="off" onChange={e => setVals({ ...vals, [f.id]: e.target.value })} />}</label>)}
      {err && <div className="warn">{err}</div>}
      <button className="btn pri wide" disabled={busy}>{busy ? <Icon n="loader" /> : null}Verbinden</button>
    </form></div>}
  </>;
}

function Billing({ ctx }: { ctx: Ctx }) {
  const t = ctx.st.tenant!, inv = t.invoice!;
  const [s, setS] = useState(inv.seller), [no, setNo] = useState(String(inv.nextNo)), [plans, setPlans] = useState(inv.plans);
  const F: [keyof typeof s, string][] = [["name", "Firma"], ["street", "Straße"], ["city", "PLZ und Ort"], ["gf", "Geschäftsführer"], ["hrb", "Handelsregister"], ["court", "Registergericht"],
    ["tax", "Steuernummer / USt-IdNr."], ["iban", "IBAN"], ["bic", "BIC"], ["email", "E-Mail für Rechnungen"]];
  async function save() {
    try { await api(`/api/tenants/${t.slug}`, { method: "PATCH", body: { invoice: { seller: s, nextNo: Number(no) || inv.nextNo, plans } } }); ctx.toast("Gespeichert"); ctx.reload(); }
    catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }
  return <>
    <div className="form">{F.map(([k, l]) => <label key={k} className="fld"><span>{l}</span><input className="inp" value={s[k]} onChange={e => setS({ ...s, [k]: e.target.value })} /></label>)}</div>
    <div className="list-box">
      <label className="row2"><span>Nächste Rechnungsnummer</span><input className="inp num" inputMode="numeric" value={no} onChange={e => setNo(e.target.value.replace(/\D/g, ""))} /></label>
      {plans.map((p, i) => <label key={p.key} className="row2"><span>{p.n} pro Monat</span><input className="inp num" inputMode="decimal" value={p.m} onChange={e => setPlans(plans.map((x, k) => k === i ? { ...x, m: Number(e.target.value.replace(",", ".").replace(/[^\d.]/g, "")) || 0 } : x))} /></label>)}
    </div>
    <div><button className="btn" onClick={save}>Speichern</button></div>
  </>;
}
