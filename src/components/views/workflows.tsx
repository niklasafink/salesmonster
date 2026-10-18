"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { Icon, Top, api, useAutosize } from "../ui";
import type { Ctx } from "../types";

type Write = "leads_add" | "leads_update" | "templates" | "report";
type Wf = { id: number; name: string; instructions: string; writes: Write[]; active: boolean; lastRun: { status: string; startedAt: string } | null };
type Run = { id: number; status: string; who: string; startedAt: string; finishedAt: string | null; counts: { added: number; skipped: number; updated: number; templates: number }; report: string };

const WRITES: [Write, string][] = [["leads_add", "Neue Leads"], ["leads_update", "Leads anreichern"], ["templates", "Mail-Vorlagen"], ["report", "Bericht"]];
const STP: Record<string, string> = { "läuft": "b", fertig: "g", abgebrochen: "a" };
const when = (iso: string) => new Date(iso).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
const NEW: Wf = { id: 0, name: "", instructions: "", writes: ["leads_add", "report"], active: true, lastRun: null };

export function Workflows({ ctx }: { ctx: Ctx }) {
  const t = ctx.st.tenant!;
  const [list, setList] = useState<Wf[] | null>(null), [cur, setCur] = useState<Wf | null>(null), [runs, setRuns] = useState<Run[]>([]), [open, setOpen] = useState<number | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null), fit = useAutosize();

  const load = async (pick?: number) => {
    const r = await api<{ rows: Wf[] }>(`/api/workflows?t=${t.slug}`);
    setList(r.rows);
    setCur(c => r.rows.find(w => w.id === (pick ?? c?.id)) || (c && !c.id ? c : r.rows[0] || null));
  };
  useEffect(() => { load().catch(e => ctx.toast(e.message)); }, [t.slug]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setRuns([]); setOpen(null);
    if (cur?.id) api<{ rows: Run[] }>(`/api/workflows/${cur.id}/runs`).then(r => setRuns(r.rows)).catch(e => ctx.toast(e.message));
  }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fit(ta.current); });

  const set = (p: Partial<Wf>) => setCur(c => c && { ...c, ...p });
  const toggleWrite = (w: Write) => cur && set({ writes: cur.writes.includes(w) ? cur.writes.filter(x => x !== w) : [...cur.writes, w] });

  async function save() {
    if (!cur) return;
    const body = { name: cur.name, instructions: cur.instructions, writes: cur.writes, active: cur.active };
    try {
      if (cur.id) { await api(`/api/workflows/${cur.id}`, { method: "PUT", body }); await load(cur.id); }
      else { const r = await api<{ id: number }>("/api/workflows", { body: { t: t.slug, ...body } }); await load(r.id); }
      ctx.toast("Workflow gespeichert");
    } catch (e) { ctx.toast((e as Error).message); }
  }
  async function del() {
    if (!cur) return;
    if (!cur.id) { setCur(list?.[0] || null); return; }
    if (!confirm(`${cur.name} löschen?`)) return;
    try { await api(`/api/workflows/${cur.id}`, { method: "DELETE" }); setCur(null); await load(); } catch (e) { ctx.toast((e as Error).message); }
  }
  const claudeUrl = cur && `https://claude.ai/new?q=${encodeURIComponent(`Starte über Sales Monster den Workflow „${cur.name}“ im Mandanten ${t.slug}.`)}`;

  const top = <Top title="Workflows" onMenu={ctx.openSidebar}>
    <button className="btn" onClick={() => setCur({ ...NEW })}><Icon n="plus" />Neu</button>
    {cur && (cur.id && cur.active ? <a className="btn" href={claudeUrl!} target="_blank" rel="noreferrer"><Icon n="external-link" />In Claude starten</a>
      : <button className="btn" disabled><Icon n="external-link" />In Claude starten</button>)}
    {cur && <button className="btn" onClick={save}>Speichern</button>}
  </Top>;
  if (!list) return top;
  if (!cur) return <>{top}<div className="empty"><div><div className="h2">Noch keine Workflows</div><button className="btn pri" onClick={() => setCur({ ...NEW })}><Icon n="plus" />Workflow anlegen</button></div></div></>;

  return <>
    {top}
    <div className="scroll"><div className="wrap"><div className="tpl">
      <div className="vlist">
        {!cur.id && <button className="vitem on"><span className="top2"><span style={{ fontWeight: 500 }}>{cur.name || "Neuer Workflow"}</span></span></button>}
        {list.map(w => <button key={w.id} className={`vitem ${w.id === cur.id ? "on" : ""}`} onClick={() => setCur(w)}>
          <span className="top2"><span className="wfn">{w.name}</span>{!w.active && <span className="pill">Pausiert</span>}{w.lastRun && <span className="rate">{day(w.lastRun.startedAt)}</span>}</span></button>)}
      </div>
      <div className="wfc">
        <div className="doc">
          <div className="vstats">
            {WRITES.map(([k, l]) => <label key={k} className="ck"><input type="checkbox" checked={cur.writes.includes(k)} onChange={() => toggleWrite(k)} />{l}</label>)}
            <div className="act">
              <button className="btn gh" onClick={del}>Löschen</button>
              <span className="f3">Aktiv</span><button className={`sw ${cur.active ? "on" : ""}`} onClick={() => set({ active: !cur.active })} aria-label="Workflow aktiv" />
            </div>
          </div>
          <input className="subj" value={cur.name} onChange={e => set({ name: e.target.value })} placeholder="Name" aria-label="Name" autoFocus={!cur.id} />
          <textarea ref={ta} className="body" value={cur.instructions} onChange={e => { set({ instructions: e.target.value }); fit(e.target); }} placeholder="Anweisung" aria-label="Anweisung" />
        </div>
        {cur.id > 0 && <div className="blk"><h3>Läufe</h3>
          <div className="tbl"><table><thead><tr><th>Status</th><th>Gestartet</th><th>Von</th><th className="ra">Neu</th><th className="ra">Übersprungen</th><th className="ra">Angereichert</th><th className="ra">Vorlagen</th><th></th></tr></thead>
            <tbody>{runs.length ? runs.map(r => <Fragment key={r.id}>
              <tr className={r.report ? "click" : ""} onClick={() => r.report && setOpen(open === r.id ? null : r.id)}>
                <td><span className={`pill ${STP[r.status] ?? ""}`}>{r.status[0].toUpperCase() + r.status.slice(1)}</span></td>
                <td className="num">{when(r.startedAt)}</td><td>{r.who}</td>
                <td className="num ra">{r.counts.added}</td><td className="num ra">{r.counts.skipped}</td><td className="num ra">{r.counts.updated}</td><td className="num ra">{r.counts.templates}</td>
                <td className="ra">{r.report && <Icon n={open === r.id ? "chevron-up" : "chevron-down"} />}</td>
              </tr>
              {open === r.id && <tr><td colSpan={8} className="wfr"><div className="cl-md"><Markdown>{r.report}</Markdown></div></td></tr>}
            </Fragment>) : <tr><td colSpan={8} className="f3" style={{ padding: "32px 0", textAlign: "center" }}>Noch keine Läufe.</td></tr>}</tbody>
          </table></div></div>}
      </div>
    </div></div></div>
  </>;
}
