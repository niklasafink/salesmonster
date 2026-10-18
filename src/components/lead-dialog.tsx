"use client";
import { useState } from "react";
import type { Tender } from "@/db/schema";
import { addrsOf, modeOf } from "@/lib/company-mode";
import { SALUTATIONS, httpUrl } from "@/lib/lead-fields";
import { Icon, api, useDialog } from "./ui";

export type EditLead = {
  id?: number; company: string; salutation: string; first: string; last: string; role: string; email: string; emailType: string; phone: string;
  linkedin: string; website: string; city: string; hook: string; note: string; sourceUrl: string; research: string; status: string; tenders: Tender[]; source?: string;
};

export const STATUS: Record<string, [string, string]> = {
  neu: ["Neu", "n"], freigabe: ["In Freigabe", "a"], angeschrieben: ["Angeschrieben", "b"], beantwortet: ["Beantwortet", "g"], unzustellbar: ["Unzustellbar", "r"], dublette: ["Dublette", "x"], kontakt: ["Kontakt", "k"], papierkorb: ["Papierkorb", "t"],
};

export const emptyLead = (company = ""): EditLead => ({ company, salutation: "", first: "", last: "", role: "", email: "", emailType: "person", phone: "", linkedin: "", website: "",
  city: "", hook: "", note: "", sourceUrl: "", research: "", status: "neu", tenders: [] });

const tendersText = (ts: Tender[] = []) => ts.map(x => [x.t, x.s, x.f].filter(Boolean).join(" | ")).join("\n");
const tendersOf = (s: string): Tender[] => s.split("\n").map(r => r.split("|").map(x => x.trim())).filter(r => r[0]).map(([t, s = "", f = ""]) => ({ t, s, f }));

type Co = { id: number; mode: string; email: string };

/* Edit one contact, or add a new one; with colleagues at the same company it also sets how the company is written to */
export function LeadDialog({ lead, slug, tenders, co, contacts = [], onClose, onSaved, onDeleted, onTrash, onAdd }: {
  lead: EditLead; slug: string; tenders: boolean; co?: Co; contacts?: { email: string; status: string }[]; onClose: () => void; onSaved: (l: EditLead) => void; onDeleted?: (id: number) => void; onTrash?: () => void; onAdd?: (company: string) => void;
}) {
  const [f, setF] = useState(lead), [tt, setTt] = useState(tendersText(lead.tenders)), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const set = (k: keyof EditLead) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const ref = useDialog(onClose);
  contacts = contacts.filter(c => c.status !== "papierkorb");
  const addrs = addrsOf(contacts), m = co && contacts.length > 1 && addrs.length ? modeOf(co, contacts) : null;
  const mode0 = m ? (m.mode === "eine" ? `eine:${m.to[0] || ""}` : m.mode) : "", [mode, setMode] = useState(mode0);

  async function save() {
    setBusy(true); setErr("");
    const next = { ...f, tenders: tendersOf(tt) };
    /* only what changed, so fields the caller did not load stay as they are */
    const body = Object.fromEntries(Object.entries(next).filter(([k, v]) => k !== "id" && k !== "source" && JSON.stringify(v) !== JSON.stringify(lead[k as keyof EditLead])));
    try {
      if (f.id) {
        if (Object.keys(body).length) await api(`/api/leads/${f.id}`, { method: "PATCH", body });
        if (co && mode !== mode0) { const [mo, email = ""] = mode.split(":"); await api(`/api/companies/${co.id}`, { method: "PATCH", body: { mode: mo, email } }); }
        onSaved(next);
      }
      else { const r = await api<{ id: number }>("/api/leads", { body: { t: slug, lead: next } }); onSaved({ ...next, id: r.id, status: "neu" }); }
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  async function del() {
    if (!f.id || !confirm(`${[f.first, f.last].filter(Boolean).join(" ") || f.company} löschen?`)) return;
    try { await api(`/api/leads/${f.id}`, { method: "DELETE" }); onDeleted?.(f.id); } catch (e) { setErr((e as Error).message); }
  }

  return <div className="ov" onClick={e => e.target === e.currentTarget && onClose()}><div className="dlg lg" ref={ref} role="dialog" aria-modal="true" aria-label={f.id ? "Kontakt bearbeiten" : "Kontakt hinzufügen"}>
    <div className="dlg-h">{f.id ? [f.first, f.last].filter(Boolean).join(" ") || f.company : "Kontakt hinzufügen"}<button className="btn gh ic" onClick={onClose} aria-label="Schließen"><Icon n="x" /></button></div>
    <div className="fgrid">
      <label className="fld s1"><span>Anrede</span><select className="inp sel" value={f.salutation} onChange={set("salutation")}><option value="">–</option>{SALUTATIONS.map(s => <option key={s}>{s}</option>)}</select></label>
      <label className="fld s2"><span>Vorname</span><input className="inp" value={f.first} onChange={set("first")} /></label>
      <label className="fld s3"><span>Nachname</span><input className="inp" value={f.last} onChange={set("last")} /></label>
      <label className="fld s3"><span>Firma</span><input className="inp" value={f.company} onChange={set("company")} /></label>
      <label className="fld s3"><span>Rolle</span><input className="inp" value={f.role} onChange={set("role")} /></label>
      <label className="fld s4"><span>E-Mail</span><input className="inp mono" value={f.email} onChange={set("email")} /></label>
      <label className="fld s2"><span>Adresse</span><select className="inp sel" value={f.emailType} onChange={set("emailType")}><option value="person">Persönlich</option><option value="info">Sammeladresse</option></select></label>
      <label className="fld s2"><span>Telefon</span><input className="inp num" value={f.phone} onChange={set("phone")} /></label>
      <label className="fld s2"><span>Ort</span><input className="inp" value={f.city} onChange={set("city")} /></label>
      <label className="fld s2"><span>Website</span><input className="inp" value={f.website} onChange={set("website")} /></label>
      <label className="fld s6"><span>LinkedIn</span><input className="inp" value={f.linkedin} onChange={set("linkedin")} /></label>
      {tenders
        ? <label className="fld s6"><span>Ausschreibungen</span><textarea className="inp ta" rows={3} value={tt} placeholder="Titel | Vergabestelle | Frist" onChange={e => setTt(e.target.value)} /></label>
        : <label className="fld s6"><span>Anlass</span><input className="inp" value={f.hook} onChange={set("hook")} /></label>}
      <label className="fld s2"><span>Status</span><select className="inp sel" value={f.status} onChange={set("status")} disabled={!f.id}>{Object.entries(STATUS).map(([k, [n]]) => <option key={k} value={k}>{n}</option>)}</select></label>
      <label className="fld s4"><span>Quelle{httpUrl(f.sourceUrl) && <a className="src" href={httpUrl(f.sourceUrl)} target="_blank" rel="noreferrer" aria-label="Quelle öffnen"><Icon n="external-link" /></a>}</span><input className="inp" value={f.sourceUrl} placeholder="https://" onChange={set("sourceUrl")} /></label>
      {m && <label className="fld s6"><span>Anschreiben</span><select className="inp sel" value={mode} onChange={e => setMode(e.target.value)}>
        <option value="einzeln">Jede der {contacts.length} Personen einzeln</option>
        {addrs.length > 1 && <option value="alle">Eine Mail an alle Adressen</option>}
        {addrs.map(a => <option key={a} value={`eine:${a}`}>Eine Mail an {a}</option>)}
      </select></label>}
      <label className="fld s6"><span>Notiz</span><textarea className="inp ta" rows={2} value={f.note} onChange={set("note")} /></label>
      {(f.id || f.research) && <label className="fld s6"><span>Original</span><textarea className="inp ta" rows={3} value={f.research} onChange={set("research")} /></label>}
    </div>
    {err && <div className="warn"><Icon n="triangle-alert" />{err}</div>}
    <div className="dlg-f">
      {f.id && onTrash && lead.status !== "papierkorb" ? <button className="btn gh" onClick={onTrash}><Icon n="trash-2" />Löschen</button>
        : f.id && onDeleted && <button className="btn gh" onClick={del}>Endgültig löschen</button>}
      {f.id && onAdd && <button className="btn gh" onClick={() => onAdd(f.company)}><Icon n="plus" />Weiterer Kontakt</button>}
      <span className="sp" />
      <button className="btn sec" onClick={onClose}>Abbrechen</button>
      <button className="btn pri" onClick={save} disabled={busy || !f.company.trim()}>{busy && <Icon n="loader" />}Speichern</button>
    </div>
  </div></div>;
}
