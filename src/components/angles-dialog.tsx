"use client";
import { useCallback, useEffect, useState } from "react";
import { Icon, api, pct, useDialog } from "./ui";

type Angle = { id: number; label: string; query: string; origin: string; active: boolean; rounds: number; leads: number; sent: number; replies: number; score: number };
const ORIGIN: Record<string, string> = { start: "Start", ki: "KI", nutzer: "Eigene" };

/* The research's search directions with how they did; the AI adds and pauses its own, the user can add and switch any */
export function AnglesDialog({ slug, onClose, toast }: { slug: string; onClose: () => void; toast: (m: string, o?: { error: true }) => void }) {
  const [rows, setRows] = useState<Angle[] | null>(null), [label, setLabel] = useState(""), [busy, setBusy] = useState(false);
  const ref = useDialog(onClose);
  const load = useCallback(() => api<{ rows: Angle[] }>(`/api/angles?t=${slug}`).then(r => setRows(r.rows)).catch(e => toast(e.message, { error: true })), [slug, toast]);
  useEffect(() => { load(); }, [load]);

  async function toggle(a: Angle) {
    setRows(rs => rs && rs.map(x => x.id === a.id ? { ...x, active: !a.active } : x));
    try { await api(`/api/angles/${a.id}`, { method: "PATCH", body: { active: !a.active } }); } catch (e) { toast((e as Error).message, { error: true }); load(); }
  }
  async function add() {
    if (!label.trim()) return;
    setBusy(true);
    try { await api("/api/angles", { body: { t: slug, label } }); setLabel(""); await load(); } catch (e) { toast((e as Error).message, { error: true }); }
    setBusy(false);
  }
  const sorted = rows && [...rows].sort((a, b) => Number(b.active) - Number(a.active) || b.score - a.score);

  return <div className="ov" onClick={e => e.target === e.currentTarget && onClose()}><div className="dlg lg2" ref={ref} role="dialog" aria-modal="true" aria-label="Suchrichtungen">
    <div className="dlg-h">Suchrichtungen<button className="btn gh ic" onClick={onClose} aria-label="Schließen"><Icon n="x" /></button></div>
    <div className="tbl"><table className="angles"><thead><tr><th>Suchrichtung</th><th className="n">Leads</th><th className="n">Antworten</th><th className="n">Erfolg</th><th className="hide-m">Herkunft</th><th></th></tr></thead><tbody>
      {!sorted ? <tr><td colSpan={6} className="f3"><Icon n="loader" /></td></tr> : sorted.map(a => <tr key={a.id} className={a.active ? "" : "off"}>
        <td title={a.query !== a.label ? a.query : undefined}>{a.label}</td>
        <td className="n">{a.leads}</td><td className="n">{a.replies}</td><td className="n">{pct(a.score * 100)}</td>
        <td className="hide-m f2">{ORIGIN[a.origin] || a.origin}</td>
        <td className="sw-c"><button className={`sw ${a.active ? "on" : ""}`} onClick={() => toggle(a)} role="switch" aria-checked={a.active} aria-label={`${a.label} aktiv`} /></td>
      </tr>)}
    </tbody></table></div>
    <div className="dlg-f"><input className="inp" style={{ flex: 1 }} value={label} placeholder="Neue Suchrichtung, z. B. Kanalbau mit neuen Aufträgen" aria-label="Neue Suchrichtung"
      onChange={e => setLabel(e.target.value)} onKeyDown={e => { if (e.key === "Enter") add(); }} />
      <button className="btn pri" onClick={add} disabled={busy || !label.trim()}>{busy && <Icon n="loader" />}Hinzufügen</button></div>
  </div></div>;
}
