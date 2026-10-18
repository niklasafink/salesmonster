"use client";
import { useCallback, useEffect, useState } from "react";
import { Icon, Top, api } from "../ui";
import type { Ctx } from "../types";
import { parseCsv, toTsv } from "@/lib/sheet";

type Lead = { id: number; company: string; first: string; last: string; role: string; email: string; city: string; source: string; status: string; note: string };
type Sheet = { sheet: string; data: unknown[][] };
type Parsed = { co: string; p: string; role: string; email: string; web: string; city: string; dup: string; extra: string };
const LS: Record<string, [string, string]> = { neu: ["Neu", "b"], freigabe: ["In Freigabe", "a"], angeschrieben: ["Angeschrieben", ""], beantwortet: ["Beantwortet", "g"], unzustellbar: ["Unzustellbar", "r"], dublette: ["Dublette", ""] };
const FILTERS: [string, string][] = [["alle", "Alle"], ["neu", "Neu"], ["freigabe", "In Freigabe"], ["angeschrieben", "Angeschrieben"], ["beantwortet", "Beantwortet"], ["dublette", "Dublette"]];

export function Leads({ ctx }: { ctx: Ctx }) {
  const t = ctx.st.tenant!;
  const [rows, setRows] = useState<Lead[]>([]), [filter, setFilter] = useState("alle"), [src, setSrc] = useState("alle"), [q, setQ] = useState("");
  const [imp, setImp] = useState<null | { text: string; src: string; rows: Parsed[] | null; busy: boolean }>(null);
  const [sheets, setSheets] = useState<{ list: Sheet[]; i: number } | null>(null);
  const load = useCallback(() => api<{ rows: Lead[] }>(`/api/leads?t=${t.slug}`).then(r => setRows(r.rows)).catch(e => ctx.toast(e.message)), [t.slug, ctx]);
  useEffect(() => { load(); }, [load]);

  const srcs = [...new Set(rows.map(r => r.source))], ql = q.toLowerCase();
  const cnt = (s: string) => rows.filter(r => s === "alle" || r.status === s).length;
  const vis = rows.filter(r => (filter === "alle" || r.status === filter) && (src === "alle" || r.source === src) && (!ql || `${r.company} ${r.first} ${r.last} ${r.email}`.toLowerCase().includes(ql)));

  async function setStatus(r: Lead, status: string) {
    setRows(rs => rs.map(x => x.id === r.id ? { ...x, status } : x));
    try { await api(`/api/leads/${r.id}`, { method: "PATCH", body: { status } }); } catch (e) { ctx.toast((e as Error).message); load(); }
  }
  /* Files become tab-separated text with header row, then run through the normal parse */
  async function pick(f?: File) {
    if (!f || !imp) return;
    const ext = f.name.split(".").pop()?.toLowerCase(), src = imp.src || f.name.replace(/\.\w+$/, "");
    try {
      if (ext === "csv") {
        const buf = await f.arrayBuffer();
        let txt; try { txt = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { txt = new TextDecoder("windows-1252").decode(buf); }
        setImp({ ...imp, src, text: toTsv(parseCsv(txt)) }); setSheets(null);
      } else if (ext === "xlsx") {
        const { default: read } = await import("read-excel-file/browser");
        const list = await read(f).catch(() => { throw new Error("Datei nicht lesbar"); });
        setImp({ ...imp, src, text: toTsv(list[0].data) }); setSheets(list.length > 1 ? { list, i: 0 } : null);
      } else throw new Error("Nur .xlsx und .csv");
    } catch (e) { ctx.toast((e as Error).message); }
  }
  function pickSheet(i: number) {
    if (!imp || !sheets) return; setSheets({ ...sheets, i });
    try { setImp({ ...imp, text: toTsv(sheets.list[i].data) }); } catch (e) { ctx.toast((e as Error).message); setImp({ ...imp, text: "" }); }
  }
  async function parse() {
    if (!imp) return; setImp({ ...imp, busy: true });
    try { const r = await api<{ rows: Parsed[] }>("/api/leads/parse", { body: { t: t.slug, text: imp.text } }); setImp({ ...imp, rows: r.rows, busy: false }); }
    catch (e) { ctx.toast((e as Error).message); setImp({ ...imp, busy: false }); }
  }
  async function save() {
    if (!imp?.rows) return;
    const add = imp.rows.filter(r => !r.dup);
    try { await api("/api/leads", { body: { t: t.slug, rows: add, source: imp.src || "Import" } }); ctx.toast(`${add.length} Leads übernommen`); setImp(null); setFilter("neu"); load(); }
    catch (e) { ctx.toast((e as Error).message); }
  }

  const ok = imp?.rows?.filter(r => !r.dup).length || 0;
  return <>
    <Top title="Leads" onMenu={ctx.openSidebar}><button className="btn pri" onClick={() => { setImp({ text: "", src: "", rows: null, busy: false }); setSheets(null); }}><Icon n="upload" />Importieren</button></Top>
    <div className="scroll"><div className="wrap wide">
      <div className="toolbar">
        <div className="filters">{FILTERS.map(([k, n]) => <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{n}<span className="c">{cnt(k)}</span></button>)}</div>
        <div className="row3">
          <select className="inp sel" value={src} onChange={e => setSrc(e.target.value)} aria-label="Quelle"><option value="alle">Alle Quellen</option>{srcs.map(s => <option key={s}>{s}</option>)}</select>
          <div className="search"><Icon n="search" /><input className="inp" placeholder="Firma, Person, E-Mail" value={q} onChange={e => setQ(e.target.value)} aria-label="Suchen" /></div>
        </div>
      </div>
      <div className="tbl"><table><thead><tr><th>Firma</th><th>Ansprechpartner</th><th className="hide-m">Rolle</th><th>E-Mail</th><th>Quelle</th><th>Status</th></tr></thead><tbody>
        {vis.length ? vis.map(r => <tr key={r.id}>
          <td style={{ fontWeight: 500 }}>{r.company}</td>
          <td>{r.last ? `${r.first} ${r.last}` : <span className="f3">–</span>}</td>
          <td className="hide-m f2">{r.role || <span className="f3">–</span>}</td>
          <td className="mono" style={{ fontSize: 12.5 }}>{r.email || <span className="f3">fehlt</span>}</td>
          <td className="f2">{r.source}</td>
          <td><span className={`pill lst ${LS[r.status]?.[1] || ""}`} title={r.note || undefined}>
            <select value={r.status} onChange={e => setStatus(r, e.target.value)} aria-label="Status">{Object.entries(LS).map(([k, [n]]) => <option key={k} value={k}>{n}</option>)}</select></span></td>
        </tr>) : <tr><td colSpan={6} className="f3" style={{ padding: "32px 0", textAlign: "center" }}>{rows.length ? "Keine Treffer." : "Noch keine Leads."}</td></tr>}
      </tbody></table></div>
    </div></div>

    {imp && <div className="ov" onClick={e => e.target === e.currentTarget && setImp(null)}><div className="dlg lg">
      {!imp.rows ? <>
        <div className="dlg-h">Leads importieren<button className="btn gh ic" onClick={() => setImp(null)} aria-label="Schließen"><Icon n="x" /></button></div>
        <div style={{ display: "flex", gap: 8 }}>
          <label className="btn sec"><Icon n="upload" />Datei wählen<input type="file" accept=".xlsx,.csv" hidden onChange={e => { pick(e.target.files?.[0]); e.target.value = ""; }} /></label>
          {sheets && <select className="inp" style={{ width: "auto" }} aria-label="Blatt" value={sheets.i} onChange={e => pickSheet(Number(e.target.value))}>{sheets.list.map((s, i) => <option key={i} value={i}>{s.sheet}</option>)}</select>}
        </div>
        <label className="fld"><span>Daten</span><textarea className="prompt" style={{ minHeight: 220 }} placeholder="Liste, Tabelle oder Text einfügen" value={imp.text} onChange={e => setImp({ ...imp, text: e.target.value })} autoFocus /></label>
        <label className="fld"><span>Quelle</span><input className="inp" value={imp.src} placeholder="z. B. DTVP Oktober" onChange={e => setImp({ ...imp, src: e.target.value })} /></label>
        <button className="btn pri wide" onClick={parse} disabled={imp.busy || !imp.text.trim()}>{imp.busy && <Icon n="loader" />}Daten erkennen</button>
      </> : <>
        <div className="dlg-h">{imp.rows.length} Firmen erkannt<button className="btn gh ic" onClick={() => setImp(null)} aria-label="Schließen"><Icon n="x" /></button></div>
        <div className="tbl"><table><thead><tr><th>Firma</th><th>Ansprechpartner</th><th>E-Mail</th><th></th></tr></thead><tbody>
          {imp.rows.map((r, i) => <tr key={i}><td style={{ fontWeight: 500 }}>{r.co}</td><td>{r.p ? <>{r.p}{r.role && <span className="f3"> ({r.role})</span>}</> : <span className="f3">–</span>}</td>
            <td className="mono" style={{ fontSize: 12.5 }}>{r.email || (r.web ? <span className="f3">{r.web}</span> : <span className="f3">fehlt</span>)}</td>
            <td>{r.dup ? <span className="pill">{r.dup}</span> : r.extra ? <span className="pill">{r.extra}</span> : null}</td></tr>)}
        </tbody></table></div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button className="btn sec" onClick={() => setImp({ ...imp, rows: null })}>Zurück</button><button className="btn pri" onClick={save} disabled={!ok}>{ok} Leads übernehmen</button></div>
      </>}
    </div></div>}
  </>;
}
