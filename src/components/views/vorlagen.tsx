"use client";
import { useEffect, useRef, useState } from "react";
import { PLACEHOLDERS, fill, type FillLead } from "@/lib/fill";
import { Top, api, pct, rate, useAutosize } from "../ui";
import type { Ctx, Tpl } from "../types";

const SAMPLE: FillLead = { company: "Muster Bau GmbH", first: "Katrin", last: "Albers", salutation: "Frau", emailType: "person", hook: "die neue Niederlassung in Halle",
  tenders: [{ t: "Erneuerung Regenwasserkanal, 2. Bauabschnitt", s: "Umweltbetrieb Stadt Bielefeld" }, { t: "Deckenerneuerung Kreisstraße K 23", s: "Kreis Gütersloh" }, { t: "Rahmenvertrag Tiefbauarbeiten 2027–2028", s: "Stadtwerke Herford" }] };

export function Vorlagen({ ctx }: { ctx: Ctx }) {
  const { st } = ctx, t = st.tenant!;
  const [list, setList] = useState<Tpl[]>(st.templates), [k, setK] = useState(st.templates[0]?.key || "A"), [mode, setMode] = useState<"edit" | "preview">("edit");
  const ta = useRef<HTMLTextAreaElement>(null), sj = useRef<HTMLInputElement>(null), last = useRef<"subject" | "body">("body"), fit = useAutosize();
  useEffect(() => { setList(st.templates); }, [st.templates]);
  useEffect(() => { fit(ta.current); });
  const cur = list.find(x => x.key === k) || list[0];
  if (!cur) return <Top title="Vorlagen" onMenu={ctx.openSidebar} />;
  const sample = st.drafts[0]?.lead || SAMPLE;
  const set = (p: Partial<Tpl>) => setList(ls => ls.map(x => x.key === cur.key ? { ...x, ...p } : x));

  async function saveTpl() {
    try { await api(`/api/templates/${cur.id}`, { method: "PUT", body: { subject: cur.subject, body: cur.body, name: cur.name, tone: cur.tone } }); ctx.toast(`Vorlage ${cur.key} gespeichert`); ctx.reload(); }
    catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }
  async function toggle() {
    const active = !cur.active;
    try { await api(`/api/templates/${cur.id}`, { method: "PUT", body: { active } }); set({ active }); ctx.reload(); } catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }
  /* into the field that had focus last, at its cursor */
  function insert(p: string) {
    const f = last.current, el = f === "subject" ? sj.current : ta.current; if (!el) return;
    const s = el.selectionStart ?? el.value.length, v = el.value.slice(0, s) + p + el.value.slice(el.selectionEnd ?? s);
    set({ [f]: v }); requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = s + p.length; });
  }

  return <>
    <Top title="Vorlagen" onMenu={ctx.openSidebar}>
      <div className="seg"><button className={mode === "edit" ? "on" : ""} onClick={() => setMode("edit")}>Bearbeiten</button><button className={mode === "preview" ? "on" : ""} onClick={() => setMode("preview")}>Vorschau</button></div>
      <button className="btn" onClick={saveTpl}>Speichern</button>
    </Top>
    <div className="scroll"><div className="wrap"><div className="tpl">
      <div className="vlist">{list.map(x => <button key={x.key} className={`vitem ${x.key === cur.key ? "on" : ""}`} onClick={() => setK(x.key)}>
        <span className="top2"><span className="vc">{x.key}</span><span style={{ fontWeight: 500 }}>{x.name}</span>{!x.active && <span className="pill">Pausiert</span>}<span className="rate">{pct(rate(x))}</span></span></button>)}</div>
      <div className="doc">
        <div className="vstats">
          <div><span className="l">Gesendet</span><span className="v">{cur.sent}</span></div>
          <div><span className="l">Antworten</span><span className="v">{cur.replies}</span></div>
          <div><span className="l">Quote</span><span className="v">{pct(rate(cur))}</span></div>
          <div><span className="l">Unzustellbar</span><span className="v">{cur.bounced}</span></div>
          <div className="act">
            <div className="seg"><button className={cur.tone === "sie" ? "on" : ""} onClick={() => set({ tone: "sie" })}>Sie</button><button className={cur.tone === "du" ? "on" : ""} onClick={() => set({ tone: "du" })}>Du</button></div>
            <span className="f3">Aktiv</span><button className={`sw ${cur.active ? "on" : ""}`} onClick={toggle} aria-label="Variante aktiv" />
          </div>
        </div>
        {mode === "edit" ? <>
          <input ref={sj} className="subj" value={cur.subject} onFocus={() => { last.current = "subject"; }} onChange={e => set({ subject: e.target.value })} aria-label="Betreff" />
          <textarea ref={ta} className="body" value={cur.body} onFocus={() => { last.current = "body"; }} onChange={e => { set({ body: e.target.value }); fit(e.target); }} aria-label="Text" />
          <div className="phs"><span className="f3" style={{ fontSize: 12 }}>Einfügen</span>{PLACEHOLDERS(t.tenders).map(p => <button key={p} className="ph" onClick={() => insert(p)}>{p}</button>)}</div>
        </> : <>
          <div className="subj">{fill(cur.subject, sample, cur, st.me.name)}</div>
          <div className="pv">{fill(cur.body, sample, cur, st.me.name)}</div>
        </>}
      </div>
    </div></div></div>
  </>;
}
