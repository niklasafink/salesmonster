"use client";
import { useEffect, useState } from "react";
import { INTEG } from "@/lib/integ-meta";
import { Icon, Top, api } from "../ui";
import type { Ctx, MailSync } from "../types";

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
    try { await api(`/api/tenants/${t.slug}`, { method: "PATCH", body: { settings: { prompt: p } } }); ctx.toast("Gespeichert"); ctx.reload(); } catch (e) { ctx.toast((e as Error).message); }
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
  async function saveN(v: string) {
    setN(v); if (!Number(v)) return;
    try { await api(`/api/tenants/${t.slug}`, { method: "PATCH", body: { settings: { leadsPerDay: Number(v) } } }); ctx.reload(); } catch (e) { ctx.toast((e as Error).message); }
  }
  async function run(job: "research" | "send") {
    setBusy(job);
    try {
      const r = await api<{ created?: number; sent?: number; failed?: number }>("/api/run", { body: { t: t.slug, job } });
      ctx.toast(job === "research" ? `${r.created ?? 0} Entwürfe erstellt` : `${r.sent ?? 0} gesendet${r.failed ? `, ${r.failed} fehlgeschlagen` : ""}`);
      ctx.reload();
    } catch (e) { ctx.toast((e as Error).message); }
    setBusy(null);
  }
  return <>
    <div className="list-box">
      <label className="row2"><span>Leads pro Tag</span><input className="inp num" inputMode="numeric" value={n} onChange={e => saveN(e.target.value.replace(/\D/g, ""))} /></label>
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
  async function disconnect(k: string) {
    try { await api(`/api/integrations?t=${t.slug}&kind=${k}`, { method: "DELETE" }); ctx.reload(); } catch (e) { ctx.toast((e as Error).message); }
  }
  return <>
    <div className="list-box">{INTEG.map(i => { const s = st.integ[i.k];
      return <div key={i.k} className="row2 int"><span className="nm"><Icon n={i.ico} />{i.name}{s?.on ? <span className="pill g">Verbunden</span> : i.auth === "pending" ? <span className="pill">Demnächst</span> : null}
</span>
        {s?.on ? <button className="btn gh act" onClick={() => disconnect(i.k)}>Trennen</button> : i.auth === "pending" ? null : <button className="btn sec" onClick={() => open(i.k)}>Verbinden</button>}</div>; })}</div>
    <AiPick ctx={ctx} />
    {(st.integ.outlook?.on || st.integ.imap?.on) && <Contacts ctx={ctx} />}
    <Connector ctx={ctx} />
    {x && <div className="ov" onClick={e => e.target === e.currentTarget && setDlg(null)}><form className="dlg" onSubmit={connect}>
      <div className="dlg-h">{x.name} verbinden<button type="button" className="btn gh ic" onClick={() => setDlg(null)} aria-label="Schließen"><Icon n="x" /></button></div>
      {x.fields!.map((f, i) => <label key={f.id} className="fld"><span>{f.label}</span>{f.options
        ? <select className="inp" value={vals[f.id] || ""} onChange={e => setVals({ ...vals, [f.id]: e.target.value })}>{f.options.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
        : <input className="inp" type={f.type || "text"} value={vals[f.id] || ""} placeholder={f.placeholder} autoFocus={i === 0} autoComplete="off" onChange={e => setVals({ ...vals, [f.id]: e.target.value })} />}</label>)}
      {err && <div className="warn">{err}</div>}
      <button className="btn pri wide" disabled={busy}>{busy ? <Icon n="loader" /> : null}Verbinden</button>
    </form></div>}
  </>;
}

/* Keys belong to the account; each tenant picks which of them answers, without connecting again */
function AiPick({ ctx }: { ctx: Ctx }) {
  const { st } = ctx, t = st.tenant!;
  if (!st.ai.options.length) return null;
  async function pick(id: string) {
    try { await api(`/api/tenants/${t.slug}`, { method: "PATCH", body: { settings: { ai: id || null } } }); ctx.reload(); } catch (e) { ctx.toast((e as Error).message); }
  }
  return <div className="list-box">
    <label className="row2 int"><span className="nm"><Icon n="sparkles" />KI für {t.name}</span>
      <select className="inp sel" value={st.ai.current || ""} onChange={e => pick(e.target.value)}>
        {!st.ai.current && <option value="">{st.ai.options[0].label}</option>}
        {st.ai.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select></label>
  </div>;
}

const n = (x: number) => x.toLocaleString("de-DE");

/* The mailbox read into the contacts; the page drives the run step by step while it is open, the morning cron continues it */
function Contacts({ ctx }: { ctx: Ctx }) {
  const t = ctx.st.tenant!;
  const [s, setS] = useState<MailSync | null>(ctx.st.mailSync), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (s?.status !== "läuft" || busy) return;
    let stop = false;
    (async () => {
      setBusy(true);
      try {
        let cur: MailSync | null = s;
        while (!stop && cur?.status === "läuft") { cur = await api<MailSync | null>("/api/mail-sync", { body: { t: t.slug, action: "step" } }); if (!stop) setS(cur); }
        if (!stop && cur?.status === "fertig") ctx.toast(`${n(cur.imported)} Kontakte im CRM`, { label: "Anzeigen", href: "#leads" });
      } catch (e) { if (!stop) ctx.toast((e as Error).message); }
      if (!stop) setBusy(false);
    })();
    return () => { stop = true; };
  }, [s?.status, t.slug]); // eslint-disable-line react-hooks/exhaustive-deps
  async function start() {
    try { setS(await api<MailSync | null>("/api/mail-sync", { body: { t: t.slug, action: "start" } })); } catch (e) { ctx.toast((e as Error).message); }
  }
  const run = s?.status === "läuft";
  const what = !s ? "" : run ? s.phase === "scan" ? `${n(s.scanned)} E-Mails gelesen` : s.phase === "signatur" ? `Signaturen von ${n(s.contacts)} Kontakten` : "Übernehme Kontakte" : `${n(s.imported)} Kontakte`;
  return <div className="list-box">
    <div className="row2 int"><span className="nm"><Icon n="users" />Kontakte aus E-Mails{s?.status === "fehler" && <span className="pill r">Fehler</span>}</span>
      <span className="row3">{what && <span className="f2 num">{run && <Icon n="loader" />}{what}</span>}
        {!run && <button className="btn sec" onClick={start}>{s ? "Aktualisieren" : "Importieren"}</button>}</span></div>
    {s?.status === "fehler" && <div className="row2"><span className="f2">{s.error}</span></div>}
  </div>;
}

type Grant = { id: number; clientName: string; createdAt: string; lastUsedAt: string | null };

/* Claude in claude.ai as custom connector: per person, not per tenant */
function Connector({ ctx }: { ctx: Ctx }) {
  const [d, setD] = useState<{ url: string; grants: Grant[] } | null>(null);
  const load = () => api<{ url: string; grants: Grant[] }>("/api/oauth/grants").then(setD).catch(e => ctx.toast((e as Error).message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function copy() {
    try { await navigator.clipboard.writeText(d!.url); ctx.toast("URL kopiert"); } catch { ctx.toast("Kopieren nicht möglich"); }
  }
  async function revoke(id: number) {
    try { await api(`/api/oauth/grants?id=${id}`, { method: "DELETE" }); load(); } catch (e) { ctx.toast((e as Error).message); }
  }
  if (!d) return null;
  return <div className="list-box">
    <div className="row2 int"><span className="nm"><Icon n="sparkles" />Claude-Connector{d.grants.length > 0 && <span className="pill g">Verbunden</span>}</span></div>
    <div className="row2"><input className="inp url" readOnly value={d.url} aria-label="Connector-URL" onFocus={e => e.target.select()} />
      <button className="btn sec" onClick={copy}><Icon n="copy" />Kopieren</button></div>
    {d.grants.map(g => <div key={g.id} className="row2"><span>{g.clientName} <span className="f3 num">{when(g.lastUsedAt || g.createdAt)}</span></span>
      <button className="btn gh act" onClick={() => revoke(g.id)}>Trennen</button></div>)}
  </div>;
}

function Billing({ ctx }: { ctx: Ctx }) {
  const t = ctx.st.tenant!, inv = t.invoice!;
  const [s, setS] = useState(inv.seller), [no, setNo] = useState(String(inv.nextNo)), [plans, setPlans] = useState(inv.plans);
  const F: [keyof typeof s, string][] = [["name", "Firma"], ["street", "Straße"], ["city", "PLZ und Ort"], ["gf", "Geschäftsführer"], ["hrb", "Handelsregister"], ["court", "Registergericht"],
    ["tax", "Steuernummer / USt-IdNr."], ["iban", "IBAN"], ["bic", "BIC"], ["email", "E-Mail für Rechnungen"]];
  async function save() {
    try { await api(`/api/tenants/${t.slug}`, { method: "PATCH", body: { invoice: { seller: s, nextNo: Number(no) || inv.nextNo, plans } } }); ctx.toast("Gespeichert"); ctx.reload(); }
    catch (e) { ctx.toast((e as Error).message); }
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
