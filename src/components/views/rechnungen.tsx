"use client";
import { useEffect, useRef, useState } from "react";
import type { InvoiceCustomer } from "@/db/schema";
import { dShort } from "@/lib/dates";
import { buildLines, eur, lineSum, totalOf } from "@/lib/invoice-calc";
import { Icon, api } from "../ui";
import type { Ctx } from "../types";

type Hit = { src: "hs" | "inv" | "lead"; co: string; domain: string; street: string; zip: string; city: string; contact: string; email: string; salut: string; vat: string };
type Inv = { id: number; number: string; customer: InvoiceCustomer; item: string; total: number; issueDate: string; dueDate: string; format: string; status: string };
const GRP: Record<string, string> = { hs: "HubSpot", inv: "Frühere Rechnungen", lead: "Leads" };
const STP: Record<string, string> = { offen: "b", bezahlt: "g", "überfällig": "a", storniert: "" };
const todayIso = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
const EMPTY: InvoiceCustomer = { co: "", attn: "", salut: "", street: "", zip: "", city: "", vat: "", email: "", domain: "" };

export function Rechnungen({ ctx }: { ctx: Ctx }) {
  const { st } = ctx, t = st.tenant!, cfg = t.invoice!;
  const [tab, setTab] = useState("neu");
  const [hist, setHist] = useState<Inv[]>([]);
  const loadHist = () => api<{ rows: Inv[] }>(`/api/invoices?t=${t.slug}`).then(r => setHist(r.rows)).catch(e => ctx.toast(e.message, { error: true }));
  useEffect(() => { loadHist(); }, [t.slug]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="inv">
    <div className="top"><button className="btn gh ic mob" onClick={e => { e.stopPropagation(); ctx.openSidebar(); }} aria-label="Menü"><Icon n="menu" /></button><h1>Rechnungen</h1>
      <div className="tabs"><button className={tab === "neu" ? "on" : ""} onClick={() => setTab("neu")}>Neue Rechnung</button>
        <button className={tab === "verlauf" ? "on" : ""} onClick={() => setTab("verlauf")}>Verlauf</button></div>
      <div className="sp" /></div>
    {tab === "neu" ? <Builder ctx={ctx} cfg={cfg} onCreated={loadHist} /> : <History ctx={ctx} rows={hist} reload={loadHist} />}
  </div>;
}

function Builder({ ctx, cfg, onCreated }: { ctx: Ctx; cfg: NonNullable<Ctx["st"]["tenant"]>["invoice"] & object; onCreated: () => void }) {
  const { st } = ctx, t = st.tenant!;
  const [q, setQ] = useState(""), [dd, setDd] = useState(false), [ddI, setDdI] = useState(0), [hits, setHits] = useState<Hit[]>([]);
  const [cust, setCust] = useState<Hit | null>(null), [f, setF] = useState<InvoiceCustomer>(EMPTY);
  const [plan, setPlanK] = useState(cfg.plans.find(p => p.key === "premium")?.key || cfg.plans[0].key), [cycle, setCycle] = useState<"monat" | "jahr">("jahr");
  const [price, setPrice] = useState(String(cfg.plans.find(p => p.key === plan)!.m)), [start, setStart] = useState(todayIso()), [dueDays, setDueDays] = useState(14);
  const [fmt, setFmt] = useState<"zugferd" | "xrechnung">("zugferd"), [leitweg, setLeitweg] = useState(""), [user, setUser] = useState(st.me.id);
  const [busy, setBusy] = useState<string | null>(null), [imp, setImp] = useState(false);
  const [pdf, setPdf] = useState<string | null>(null);
  const qRef = useRef<HTMLInputElement>(null), timer = useRef<ReturnType<typeof setTimeout>>(undefined), pdfTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!dd) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => api<{ rows: Hit[] }>(`/api/customers?t=${t.slug}&q=${encodeURIComponent(q)}`).then(r => { setHits(r.rows); setDdI(0); }).catch(() => setHits([])), 220);
  }, [q, dd, t.slug]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(".cs")) setDd(false); };
    addEventListener("click", close); return () => removeEventListener("click", close);
  }, []);

  async function pick(h: Hit | "new") {
    setDd(false); setQ("");
    if (h === "new") { const c = { src: "inv" as const, co: q.trim(), domain: "", street: "", zip: "", city: "", contact: "", email: "", salut: "", vat: "" }; setCust(c); setF({ ...EMPTY, co: c.co }); return; }
    setCust(h);
    const next = { co: h.co, attn: h.contact, street: h.street, zip: h.zip, city: h.city, salut: h.salut, vat: h.vat, email: h.email, domain: h.domain };
    setF(next);
    if (h.domain && (!h.street || !h.salut) && st.ai.options.length > 0) {
      setImp(true);
      try {
        const r = await api<{ street: string; zip: string; city: string; gf: string; vat: string }>(`/api/impressum?t=${t.slug}&domain=${encodeURIComponent(h.domain)}`);
        setF(cur => ({ ...cur, street: cur.street || r.street, zip: cur.zip || r.zip, city: cur.city || r.city, salut: cur.salut || r.gf, vat: cur.vat || r.vat }));
      } catch (e) { ctx.toast((e as Error).message, { error: true }); }
      setImp(false);
    }
  }
  function setPlan(k: string) { setPlanK(k); setPrice(String(cfg.plans.find(p => p.key === k)!.m)); }

  const amount = Math.max(0, Number(price.replace(/\./g, "").replace(",", ".")) || 0);
  const p = cfg.plans.find(x => x.key === plan)!, { lines: L } = buildLines({ plan: p, cycle, price: amount, start }), total = totalOf(L);
  const draft = { t: t.slug, customer: f, plan, cycle, price: amount, start, dueDays, format: fmt, leitweg, contactId: user };
  const draftKey = JSON.stringify(draft);

  useEffect(() => {
    clearTimeout(pdfTimer.current);
    let url: string | null = null, gone = false;
    pdfTimer.current = setTimeout(async () => {
      const r = await fetch("/api/invoices/preview", { method: "POST", headers: { "content-type": "application/json" }, body: draftKey }).catch(() => null);
      if (!r?.ok || gone) return;
      url = URL.createObjectURL(await r.blob());
      if (!gone) setPdf(url);
    }, 400);
    return () => { gone = true; clearTimeout(pdfTimer.current); if (url) setTimeout(() => URL.revokeObjectURL(url!), 2000); };
  }, [draftKey]);
  const missing = !cust ? ["Kunde"] : [...(["co", "street", "zip", "city"] as const).filter(k => !f[k]), ...(fmt === "xrechnung" && !leitweg ? ["Leitweg-ID"] : [])];

  async function create(sendIt: boolean) {
    setBusy(sendIt ? "send" : "create");
    try {
      const inv = await api<{ id: number; number: string }>("/api/invoices", { body: draft });
      onCreated(); ctx.reload();
      if (sendIt) { const r = await api<{ to: string }>(`/api/invoices/${inv.id}/send`, { method: "POST", body: {} }); ctx.toast(`Rechnung ${inv.number} an ${r.to} gesendet`); }
      else ctx.toast(`Rechnung ${inv.number} erstellt`, { label: fmt === "zugferd" ? "PDF" : "XML", href: `/api/invoices/${inv.id}/file` });
      setCust(null); setF(EMPTY); setLeitweg("");
    } catch (e) { ctx.toast((e as Error).message, { error: true }); }
    setBusy(null);
  }

  const fld = (k: keyof InvoiceCustomer, label: string) => <div className="fld"><label htmlFor={`f-${k}`}>{label}</label>
    <input className="inp" id={`f-${k}`} value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} /></div>;
  let lastGrp = "";

  return <div className="builder">
    <div className="form">
      <div className="part"><h3>Kunde</h3>
        {cust ? <div className="cust"><div className="m"><div className="t">{f.co || cust.co}</div></div>
          {imp && <Icon n="loader" />}
          <button className="btn gh ic" onClick={() => { setCust(null); setF(EMPTY); setDd(true); setTimeout(() => qRef.current?.focus()); }} aria-label="Anderen Kunden wählen"><Icon n="x" /></button></div>
        : <div className="cs"><Icon n="search" className="lead" />
          <input ref={qRef} className="inp" placeholder={st.integ.hubspot?.on ? "Firma in HubSpot suchen" : "Firma suchen"} value={q} autoComplete="off"
            onFocus={() => setDd(true)} onChange={e => { setQ(e.target.value); setDd(true); }}
            onKeyDown={e => { const n = hits.length + (q.trim() ? 1 : 0);
              if (e.key === "ArrowDown") { e.preventDefault(); setDdI(i => Math.min(n - 1, i + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setDdI(i => Math.max(0, i - 1)); }
              else if (e.key === "Enter") { e.preventDefault(); if (ddI < hits.length) pick(hits[ddI]); else if (q.trim()) pick("new"); }
              else if (e.key === "Escape") setDd(false); }} />
          {dd && <div className="dd">
            {hits.map((h, k) => { const head = GRP[h.src] !== lastGrp ? <div className="grp">{GRP[h.src]}</div> : null; lastGrp = GRP[h.src];
              return <div key={h.src + h.co + k}>{head}<button className={k === ddI ? "hi" : ""} onClick={() => pick(h)}><span className="m"><span className="t">{h.co}</span></span></button></div>; })}
            {q.trim() && <button className={ddI === hits.length ? "hi" : ""} onClick={() => pick("new")}><Icon n="plus" /><span className="m"><span className="t">„{q.trim()}“ neu anlegen</span></span></button>}
          </div>}
        </div>}
      </div>
      {cust && <div className="part"><h3>Rechnungsempfänger</h3>
        {fld("co", "Firma")}
        <div className="row2">{fld("attn", "z. H.")}{fld("salut", "Anrede im Brief")}</div>
        {fld("street", "Straße")}
        <div className="row3">{fld("zip", "PLZ")}{fld("city", "Ort")}</div>
        <div className="row2">{fld("vat", "USt-IdNr.")}{fld("email", "Rechnung an")}</div>
      </div>}
      <div className="part"><h3>Tarif</h3>
        <div className="plans">{cfg.plans.map(v => <button key={v.key} className={`plan ${plan === v.key ? "on" : ""}`} onClick={() => setPlan(v.key)}><span className="n">{v.n}</span><span className="p">{v.key === "enterprise" ? "ab " : ""}{eur(v.m)} / Monat</span></button>)}</div>
        <div className="seg"><button className={cycle === "monat" ? "on" : ""} onClick={() => setCycle("monat")}>Monatlich</button><button className={cycle === "jahr" ? "on" : ""} onClick={() => setCycle("jahr")}>Jährlich</button></div>
        <div className="row2">
          <div className="fld"><label htmlFor="price">Preis pro Monat</label><input className="inp ra" id="price" inputMode="decimal" autoComplete="off" value={price} onChange={e => setPrice(e.target.value.replace(/[^\d.,]/g, ""))} /></div>
          <div className="fld"><label htmlFor="start">Leistungsbeginn</label><input className="inp" id="start" type="date" value={start} onChange={e => e.target.value && setStart(e.target.value)} /></div>
        </div>
        <div className="sum">
          {L.map((l, i) => <div key={i}><span>{l.disc ? "Rabatt, 2 Monate" : `${l.qty} × ${eur(l.unit)}`}</span><span className="num">{eur(lineSum(l))}</span></div>)}
          <div className="tot"><span>Gesamt</span><span className="num">{eur(total)}</span></div>
        </div>
      </div>
      <div className="part"><h3>E-Rechnung</h3>
        <div className="seg"><button className={fmt === "zugferd" ? "on" : ""} onClick={() => setFmt("zugferd")}>ZUGFeRD</button><button className={fmt === "xrechnung" ? "on" : ""} onClick={() => setFmt("xrechnung")}>XRechnung</button></div>
        {fmt === "xrechnung" && <div className="fld"><label htmlFor="leitweg">Leitweg-ID</label><input className="inp" id="leitweg" value={leitweg} onChange={e => setLeitweg(e.target.value)} /></div>}
        <div className="row2">
          <div className="fld"><label htmlFor="due">Zahlungsziel</label><select className="inp" id="due" value={dueDays} onChange={e => setDueDays(Number(e.target.value))}>{[7, 14, 30].map(n => <option key={n} value={n}>{n} Tage</option>)}</select></div>
          <div className="fld"><label htmlFor="user">Ansprechpartner</label><select className="inp" id="user" value={user} onChange={e => setUser(Number(e.target.value))}>{st.users.map(u => <option key={u.id} value={u.id}>{u.short}</option>)}</select></div>
        </div>
      </div>
      <div className="foot">
        <button className="btn sec" onClick={() => create(true)} disabled={!!missing.length || !!busy || !f.email}><Icon n={busy === "send" ? "loader" : "send"} />Senden</button>
        <button className="btn pri" onClick={() => create(false)} disabled={!!missing.length || !!busy}><Icon n={busy === "create" ? "loader" : "file-check-2"} />E-Rechnung erstellen</button>
      </div>
    </div>
    <div className="pvw">{pdf && <iframe src={`${pdf}#view=FitH`} title="Rechnung" />}</div>
  </div>;
}

function History({ ctx, rows, reload }: { ctx: Ctx; rows: Inv[]; reload: () => void }) {
  async function setStatus(r: Inv, status: string) {
    try { await api(`/api/invoices/${r.id}`, { method: "PATCH", body: { status } }); reload(); } catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }
  return <div className="scroll"><div className="wrap"><div className="tbl"><table className="t">
    <thead><tr><th>Nr.</th><th>Kunde</th><th>Leistung</th><th>Datum</th><th>Fällig</th><th>Format</th><th>Status</th><th className="ra">Betrag</th><th></th></tr></thead>
    <tbody>{rows.length ? rows.map(h => <tr key={h.id}>
      <td className="num">{h.number}</td><td>{h.customer.co}</td><td>{h.item}</td>
      <td className="num">{dShort(h.issueDate)}</td><td className="num">{dShort(h.dueDate)}</td><td>{h.format === "zugferd" ? "ZUGFeRD" : "XRechnung"}</td>
      <td><span className={`pill lst ${STP[h.status] ?? ""}`}><select value={h.status} onChange={e => setStatus(h, e.target.value)} aria-label="Status">{Object.keys(STP).map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</select></span></td>
      <td className="num ra">{eur(h.total)}</td>
      <td><a className="btn gh ic" href={`/api/invoices/${h.id}/file`} aria-label="Herunterladen"><Icon n="download" /></a></td>
    </tr>) : <tr><td colSpan={9} className="f3" style={{ padding: "32px 0", textAlign: "center" }}>Noch keine Rechnungen.</td></tr>}</tbody>
  </table></div></div></div>;
}
