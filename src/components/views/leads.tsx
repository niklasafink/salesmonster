"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import type { Tender } from "@/db/schema";
import { addrsOf, modeOf } from "@/lib/company-mode";
import { Icon, Top, api, useDialog } from "../ui";
import { httpUrl } from "@/lib/lead-fields";
import { LeadDialog, STATUS, emptyLead, type EditLead } from "../lead-dialog";
import type { Ctx } from "../types";
import { parseCsv, toTsv } from "@/lib/sheet";

type Lead = EditLead & { id: number; companyId: number | null; source: string; tenders: Tender[] };
type Sheet = { sheet: string; data: unknown[][] };
type Company = { id: number; name: string; mode: string; email: string };
type Parsed = { co: string; sal?: string; p: string; role: string; email: string; web: string; city: string; dup: string; extra: string };
const FILTERS = ["alle", "neu", "freigabe", "angeschrieben", "beantwortet", "unzustellbar", "dublette", "kontakt"];

export const Dot = ({ s }: { s: string }) => <span className={`sd s-${STATUS[s]?.[1] || "n"}`} title={STATUS[s]?.[0] || s} />;

/* accent-insensitive search: "zoe" finds Zoë, "mueller" and "muller" find Müller */
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const umlaut = (s: string) => fold(s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss"));
export const matches = (hay: string, q: string) => { const f = fold(q.trim()); return !f || fold(hay).includes(f) || umlaut(hay).includes(f); };

export function Leads({ ctx, focus, onFocused }: { ctx: Ctx; focus?: number | null; onFocused?: () => void }) {
  const t = ctx.st.tenant!;
  const [rows, setRows] = useState<Lead[]>([]), [cos, setCos] = useState<Company[]>([]), [filter, setFilter] = useState("alle"), [src, setSrc] = useState("alle"), [q, setQ] = useState("");
  const [imp, setImp] = useState<null | { text: string; src: string; auto?: boolean; rows: Parsed[] | null; busy: boolean }>(null);
  const [sheets, setSheets] = useState<{ list: Sheet[]; i: number } | null>(null);
  const [edit, setEdit] = useState<EditLead | null>(null);
  const impRef = useDialog(() => setImp(null));
  const load = useCallback(() => api<{ rows: Lead[]; companies: Company[] }>(`/api/leads?t=${t.slug}`).then(r => { setRows(r.rows); setCos(r.companies); }).catch(e => ctx.toast(e.message, { error: true })), [t.slug, ctx]);
  useEffect(() => { load(); }, [load]);
  /* opened from the command palette */
  useEffect(() => { const r = focus != null && rows.find(x => x.id === focus); if (r) { setEdit(r); onFocused?.(); } }, [focus, rows, onFocused]);

  const srcs = [...new Set(rows.map(r => r.source))];
  const cnt = (s: string) => rows.filter(r => s === "alle" || r.status === s).length;
  const vis = rows.filter(r => (filter === "alle" || r.status === filter) && (src === "alle" || r.source === src) && matches(`${r.company} ${r.first} ${r.last} ${r.email}`, q));

  /* contacts grouped by company, in list order */
  const byCo = new Map<string, Lead[]>();
  for (const r of rows) { const k = r.companyId ? `c${r.companyId}` : `l${r.id}`; byCo.set(k, [...(byCo.get(k) || []), r]); }
  const groups: { key: string; all: Lead[]; shown: Lead[] }[] = [];
  for (const r of vis) {
    const key = r.companyId ? `c${r.companyId}` : `l${r.id}`;
    const g = groups.find(x => x.key === key);
    if (g) g.shown.push(r); else groups.push({ key, all: byCo.get(key)!, shown: [r] });
  }

  async function setMode(c: Company, v: string) {
    const [mode, email = ""] = v.split(":");
    setCos(cs => cs.map(x => x.id === c.id ? { ...x, mode, email: mode === "eine" ? email : x.email } : x));
    try { await api(`/api/companies/${c.id}`, { method: "PATCH", body: { mode, email } }); } catch (e) { ctx.toast((e as Error).message, { error: true }); load(); }
  }
  /* Files become tab-separated text with header row, then run through the normal parse */
  async function pick(f?: File) {
    if (!f || !imp) return;
    const ext = f.name.split(".").pop()?.toLowerCase(), name = f.name.replace(/\.\w+$/, "");
    /* reads imp at the time the file is done: a Quelle typed meanwhile stays, one taken from an earlier file name is replaced */
    const put = (text: string) => setImp(cur => cur && { ...cur, text, ...(!cur.src || cur.auto ? { src: name, auto: true } : {}) });
    try {
      if (ext === "csv") {
        const buf = await f.arrayBuffer();
        let txt; try { txt = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { txt = new TextDecoder("windows-1252").decode(buf); }
        put(toTsv(parseCsv(txt))); setSheets(null);
      } else if (ext === "xlsx") {
        const { default: read } = await import("read-excel-file/browser");
        const list = await read(f).catch(() => { throw new Error("Datei nicht lesbar"); });
        put(toTsv(list[0].data)); setSheets(list.length > 1 ? { list, i: 0 } : null);
      } else throw new Error("Nur .xlsx und .csv");
    } catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }
  function pickSheet(i: number) {
    if (!imp || !sheets) return; setSheets({ ...sheets, i });
    let text = "";
    try { text = toTsv(sheets.list[i].data); } catch (e) { ctx.toast((e as Error).message, { error: true }); }
    setImp(cur => cur && { ...cur, text });
  }
  async function parse() {
    if (!imp) return; setImp({ ...imp, busy: true });
    try { const r = await api<{ rows: Parsed[] }>("/api/leads/parse", { body: { t: t.slug, text: imp.text } }); setImp(cur => cur && { ...cur, rows: r.rows, busy: false }); }
    catch (e) { ctx.toast((e as Error).message, { error: true }); setImp(cur => cur && { ...cur, busy: false }); }
  }
  async function save() {
    if (!imp?.rows) return;
    const add = imp.rows.filter(r => !r.dup);
    try { await api("/api/leads", { body: { t: t.slug, rows: add, source: imp.src || "Import" } }); ctx.toast(`${add.length} ${add.length === 1 ? "Lead" : "Leads"} übernommen`); setImp(null); setFilter("neu"); load(); }
    catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }

  const person = (r: Lead) => r.last ? [r.salutation, r.first, r.last].filter(Boolean).join(" ") : r.first;
  const hookCell = (r: Lead) => t.tenders ? (r.tenders.length ? `${r.tenders.length} Ausschreibung${r.tenders.length > 1 ? "en" : ""}` : <span className="f3">fehlt</span>) : r.hook || <span className="f3">fehlt</span>;
  /* shared: the company has an address this contact is reached through */
  const row = (r: Lead, showCo: boolean, shared = false) => <tr key={r.id} className="click" tabIndex={0} onClick={() => setEdit(r)}
    onKeyDown={e => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setEdit(r); } }}>
    <td className="dotc"><Dot s={r.status} /></td>
    <td className="co" style={{ fontWeight: 500 }} title={showCo ? r.company : undefined}>{showCo ? r.company : ""}</td>
    <td className="pn" title={person(r) || undefined}>{person(r) || <span className="f3">–</span>}</td>
    <td className="hide-m hide-l f2 clip" title={r.role}>{r.role || <span className="f3">–</span>}</td>
    <td className="mono em" style={{ fontSize: 12.5 }} title={r.email || undefined}>{r.email || <span className="f3">{shared ? "–" : "fehlt"}</span>}</td>
    <td className="hide-m f2 clip" title={t.tenders ? undefined : r.hook}>{hookCell(r)}</td>
    <td className="hide-m f2 src">{r.sourceUrl ? <a className="srcl" href={httpUrl(r.sourceUrl) || undefined} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>{r.source}<Icon n="external-link" /></a> : r.source}</td>
  </tr>;

  const ok = imp?.rows?.filter(r => !r.dup).length || 0;
  return <>
    <Top title="Leads" onMenu={ctx.openSidebar}>
      <button className="btn sec" onClick={() => setEdit(emptyLead())}><Icon n="plus" />Kontakt</button>
      <button className="btn pri" onClick={() => { setImp({ text: "", src: "", rows: null, busy: false }); setSheets(null); }}><Icon n="upload" />Importieren</button>
    </Top>
    <div className="scroll"><div className="wrap wide">
      <div className="toolbar">
        <div className="filters">{FILTERS.map(k => <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{k !== "alle" && <Dot s={k} />}{k === "alle" ? "Alle" : STATUS[k][0]}<span className="c">{cnt(k)}</span></button>)}</div>
        <div className="row3">
          <select className="inp sel" value={src} onChange={e => setSrc(e.target.value)} aria-label="Quelle"><option value="alle">Alle Quellen</option>{srcs.map(s => <option key={s}>{s}</option>)}</select>
          <div className="search"><Icon n="search" /><input className="inp" placeholder="Firma, Person, E-Mail" value={q} onChange={e => setQ(e.target.value)} aria-label="Suchen" /></div>
        </div>
      </div>
      <div className="tbl"><table className="leads"><thead><tr><th className="dotc"></th><th>Firma</th><th>Ansprechpartner</th><th className="hide-m hide-l">Rolle</th><th>E-Mail</th><th className="hide-m">{t.tenders ? "Ausschreibungen" : "Anlass"}</th><th className="hide-m">Quelle</th></tr></thead><tbody>
        {groups.length ? groups.map(g => {
          if (g.all.length < 2) return row(g.shown[0], true);
          const c = cos.find(x => `c${x.id}` === g.key);
          const addrs = addrsOf(g.all);
          const m = c && modeOf(c, g.all), val = m ? (m.mode === "eine" ? `eine:${m.to[0] || ""}` : m.mode) : "";
          return <Fragment key={g.key}>
            <tr className="grp"><td className="dotc"></td><td colSpan={2} style={{ fontWeight: 500 }}><div className="gname" title={g.all[0].company}>{g.all[0].company}</div></td>
              <td colSpan={4} className="modec">{c && addrs.length > 0 && <select className="inp sel modesel" value={val} onChange={e => setMode(c, e.target.value)} aria-label="Wie anschreiben">
                <option value="einzeln">Getrennt anschreiben</option>
                {addrs.length > 1 && <option value="alle">Eine Mail an alle Adressen</option>}
                {addrs.map(a => <option key={a} value={`eine:${a}`}>Eine Mail an {a}</option>)}
              </select>}</td></tr>
            {g.shown.map(r => row(r, false, addrs.length > 0))}
          </Fragment>;
        }) : <tr><td colSpan={7} className="f3" style={{ padding: "32px 0", textAlign: "center" }}>{rows.length ? "Keine Treffer." : "Noch keine Leads."}</td></tr>}
      </tbody></table></div>
    </div></div>

    {edit && <LeadDialog key={edit.id ?? `new-${edit.company}`} lead={edit} slug={t.slug} tenders={t.tenders} onClose={() => setEdit(null)}
      onSaved={() => { setEdit(null); ctx.toast("Gespeichert"); load(); }}
      onDeleted={() => { setEdit(null); ctx.toast("Gelöscht"); load(); }}
      onAdd={co => { const r = edit; setEdit({ ...emptyLead(co), city: r.city, website: r.website }); }} />}

    {imp && <div className="ov" onClick={e => e.target === e.currentTarget && setImp(null)}><div className="dlg lg" ref={impRef} role="dialog" aria-modal="true" aria-label="Importieren">
      {!imp.rows ? <>
        <div className="dlg-h">Leads importieren<button className="btn gh ic" onClick={() => setImp(null)} aria-label="Schließen"><Icon n="x" /></button></div>
        <div style={{ display: "flex", gap: 8 }}>
          <label className="btn sec"><Icon n="upload" />Datei wählen<input type="file" accept=".xlsx,.csv" hidden onChange={e => { pick(e.target.files?.[0]); e.target.value = ""; }} /></label>
          {sheets && <select className="inp" style={{ width: "auto" }} aria-label="Blatt" value={sheets.i} onChange={e => pickSheet(Number(e.target.value))}>{sheets.list.map((s, i) => <option key={i} value={i}>{s.sheet}</option>)}</select>}
        </div>
        <label className="fld"><span>Daten</span><textarea className="prompt" style={{ minHeight: 220 }} placeholder="Liste, Tabelle oder Text einfügen" value={imp.text} onChange={e => setImp({ ...imp, text: e.target.value })} autoFocus /></label>
        <label className="fld"><span>Quelle</span><input className="inp" value={imp.src} placeholder="z. B. DTVP Oktober" onChange={e => setImp({ ...imp, src: e.target.value, auto: false })} /></label>
        <button className="btn pri wide" onClick={parse} disabled={imp.busy || !imp.text.trim()}>{imp.busy && <Icon n="loader" />}Daten erkennen</button>
      </> : <>
        <div className="dlg-h">{imp.rows.length} {imp.rows.length === 1 ? "Kontakt" : "Kontakte"} erkannt<button className="btn gh ic" onClick={() => setImp(null)} aria-label="Schließen"><Icon n="x" /></button></div>
        <div className="tbl"><table><thead><tr><th>Firma</th><th>Ansprechpartner</th><th>E-Mail</th><th></th></tr></thead><tbody>
          {imp.rows.map((r, i) => <tr key={i}><td style={{ fontWeight: 500 }}>{r.co}</td><td>{r.p ? <>{[r.sal, r.p].filter(Boolean).join(" ")}{r.role && <span className="f3"> ({r.role})</span>}</> : <span className="f3">–</span>}</td>
            <td className="mono" style={{ fontSize: 12.5 }}>{r.email || (r.web ? <span className="f3">{r.web}</span> : <span className="f3">fehlt</span>)}</td>
            <td>{r.dup ? <span className="pill">{r.dup}</span> : r.extra ? <span className="pill">{r.extra}</span> : null}</td></tr>)}
        </tbody></table></div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button className="btn sec" onClick={() => setImp({ ...imp, rows: null })}>Zurück</button><button className="btn pri" onClick={save} disabled={!ok}>{ok} {ok === 1 ? "Lead" : "Leads"} übernehmen</button></div>
      </>}
    </div></div>}
  </>;
}
