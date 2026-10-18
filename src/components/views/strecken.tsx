"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MailScore, SeqConfig, SeqStep } from "@/db/schema";
import { fill, type FillLead } from "@/lib/fill";
import { Icon, Top, api, pct, rate, useAutosize } from "../ui";
import type { Ctx } from "../types";

type V = { id: number; step: number; key: string; tone: string; subject: string; body: string; active: boolean; score: MailScore | null; sent: number; replies: number; bounced: number };
type P = { id: number; email: string; first: string; last: string; company: string; salutation: string; startedAt: string; step: number; status: string; lastSentAt: string | null; repliedAt: string | null };
type S = { id: number; name: string; active: boolean; steps: SeqStep[]; config: SeqConfig; templates: V[]; people: P[]; waiting: P[]; counts: Record<string, number> };

const PH = ["{{anrede}}", "{{vorname}}", "{{nachname}}", "{{firma}}", "{{absender}}"];
const SAMPLE: FillLead = { company: "Muster Bau GmbH", first: "Katrin", last: "Albers", salutation: "Frau", emailType: "person", hook: "", tenders: [] };
const STATUS: Record<string, string> = { aktiv: "Aktiv", antwort: "Antwort", beendet: "Beendet", gekauft: "Pro gekauft", abgemeldet: "Abgemeldet", unzustellbar: "Unzustellbar" };
const day = (iso: string | null) => iso ? new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "";
const who = (p: P) => [p.first, p.last].filter(Boolean).join(" ") || p.email;

export function Strecken({ ctx }: { ctx: Ctx }) {
  const { st } = ctx, t = st.tenant!;
  const [s, setS] = useState<S | null | undefined>(undefined);
  const [tab, setTab] = useState<"mails" | "kontakte" | "einstellungen">("mails");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const r = await api<{ sequences: S[] }>(`/api/sequences?t=${encodeURIComponent(t.slug)}`);
    setS(r.sequences[0] || null);
  }, [t.slug]);
  useEffect(() => { load().catch(e => ctx.toast(e.message)); }, [load, ctx]);

  async function act(label: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(label);
    try { await fn(); await load(); if (done) ctx.toast(done); } catch (e) { ctx.toast((e as Error).message); } finally { setBusy(""); }
  }

  if (s === undefined) return <Top title="Strecken" onMenu={ctx.openSidebar} />;
  if (!s) return <>
    <Top title="Strecken" onMenu={ctx.openSidebar} />
    <div className="empty"><div><div className="h2">Noch keine Strecke</div>
      <button className="btn pri" disabled={!!busy} onClick={() => act("new", () => api(`/api/sequences?t=${encodeURIComponent(t.slug)}`, { method: "POST" }))}><Icon n="plus" />Strecke anlegen</button></div></div>
  </>;

  const put = (b: object) => api(`/api/sequences/${s.id}`, { method: "PUT", body: b });

  return <>
    <Top title={s.name} onMenu={ctx.openSidebar}>
      <div className="seg">
        <button className={tab === "mails" ? "on" : ""} onClick={() => setTab("mails")}>Mails</button>
        <button className={tab === "kontakte" ? "on" : ""} onClick={() => setTab("kontakte")}>Kontakte</button>
        <button className={tab === "einstellungen" ? "on" : ""} onClick={() => setTab("einstellungen")}>Einstellungen</button>
      </div>
      {s.active && <button className="btn" disabled={!!busy} onClick={() => act("run", async () => { const r = await api<{ info: string }>(`/api/sequences/${s.id}`, { body: { action: "run" } }); ctx.toast(r.info); })}>
        {busy === "run" ? <Icon n="loader" /> : <Icon n="send" />}Jetzt ausführen</button>}
      <span className="f3">Aktiv</span><button className={`sw ${s.active ? "on" : ""}`} aria-label="Strecke aktiv" disabled={!!busy}
        onClick={() => act("active", () => put({ active: !s.active }), s.active ? "Strecke pausiert" : "Strecke läuft")} />
    </Top>
    <div className="scroll"><div className="wrap">
      {s.waiting.length > 0 && <Waiting s={s} busy={!!busy} act={act} />}
      {tab === "mails" ? <Mails key={s.id} s={s} ctx={ctx} act={act} busy={busy} />
        : tab === "kontakte" ? <People s={s} />
        : <Settings key={s.id} s={s} ctx={ctx} act={act} />}
    </div></div>
  </>;
}

type Act = (label: string, fn: () => Promise<unknown>, done?: string) => Promise<void>;

function Waiting({ s, busy, act }: { s: S; busy: boolean; act: Act }) {
  const set = (p: P, status: string) => act(`p${p.id}`, () => api(`/api/enrollments/${p.id}`, { method: "PUT", body: { status } }), status === "aktiv" ? `${who(p)}: Strecke läuft weiter` : `${who(p)}: Strecke beendet`);
  return <div className="list-box" style={{ marginBottom: 16 }}>
    {s.waiting.map(p => <div key={p.id} className="row2">
      <span><b style={{ fontWeight: 500 }}>{who(p)}</b>{p.company && <span className="f3"> · {p.company}</span>}<span className="f3"> · Antwort auf Mail {p.step} · {day(p.repliedAt)}</span></span>
      <span className="row3" style={{ gap: 8 }}>
        <button className="btn" disabled={busy} onClick={() => set(p, "aktiv")}>Weiter</button>
        <button className="btn pri" disabled={busy} onClick={() => set(p, "beendet")}>Beenden</button>
      </span>
    </div>)}
  </div>;
}

function Mails({ s, ctx, act, busy }: { s: S; ctx: Ctx; act: Act; busy: string }) {
  const [i, setI] = useState(0), [k, setK] = useState("A"), [mode, setMode] = useState<"edit" | "preview">("edit");
  const [list, setList] = useState(s.templates), [steps, setSteps] = useState(s.steps);
  const ta = useRef<HTMLTextAreaElement>(null), fit = useAutosize();
  useEffect(() => { setList(s.templates); setSteps(s.steps); }, [s]);
  useEffect(() => { fit(ta.current); });
  const step = Math.min(i, steps.length - 1), vs = list.filter(x => x.step === step);
  const cur = vs.find(x => x.key === k) || vs[0];
  const sender = ctx.st.users.find(u => u.id === s.config.senderId)?.name || ctx.st.me.name;
  const sample: FillLead = s.people[0] ? { ...SAMPLE, ...s.people[0] } : SAMPLE;
  const set = (p: Partial<V>) => cur && setList(ls => ls.map(x => x.id === cur.id ? { ...x, ...p } : x));
  const setStep = (p: Partial<SeqStep>) => setSteps(ss => ss.map((x, n) => n === step ? { ...x, ...p } : x));

  async function save() {
    await act("save", async () => {
      if (JSON.stringify(steps) !== JSON.stringify(s.steps)) await api(`/api/sequences/${s.id}`, { method: "PUT", body: { steps } });
      if (cur) await api(`/api/sequences/templates/${cur.id}`, { method: "PUT", body: { subject: cur.subject, body: cur.body, tone: cur.tone } });
    }, "Gespeichert");
  }
  function insert(p: string) {
    const el = ta.current; if (!el) return;
    const at = el.selectionStart ?? el.value.length, v = el.value.slice(0, at) + p + el.value.slice(el.selectionEnd ?? at);
    set({ body: v }); requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = at + p.length; });
  }
  const add = (action: "variant" | "propose") => act(action, async () => {
    const r = await api<V>(`/api/sequences/${s.id}`, { body: { action, step } }); setK(r.key);
  }, action === "propose" ? "Neue Variante, pausiert bis zur Freigabe" : undefined);
  const addStep = () => act("step", async () => {
    const last = steps[steps.length - 1];
    await api(`/api/sequences/${s.id}`, { method: "PUT", body: { steps: [...steps, { day: last.day + 5, name: "Neue Mail" }] } });
    await api(`/api/sequences/${s.id}`, { body: { action: "variant", step: steps.length } });
    setI(steps.length);
  });
  const dropStep = () => confirm(`Mail ${steps.length} mit allen Varianten löschen?`) && act("drop", async () => {
    await api(`/api/sequences/${s.id}`, { method: "PUT", body: { steps: steps.slice(0, -1) } }); setI(steps.length - 2);
  });

  return <div className="tpl">
    <div className="vlist">
      {steps.map((x, n) => { const v = list.filter(y => y.step === n), sent = v.reduce((a, y) => a + y.sent, 0), replies = v.reduce((a, y) => a + y.replies, 0);
        return <button key={n} className={`vitem ${n === step ? "on" : ""}`} onClick={() => { setI(n); setK("A"); }}>
          <span className="top2"><span className="vc">{n + 1}</span><span style={{ fontWeight: 500 }}>{x.name || `Mail ${n + 1}`}</span><span className="rate">Tag {x.day}</span></span>
          <span className="top2 f3" style={{ fontSize: 12 }}>{v.filter(y => y.active).map(y => y.key).join(" · ")}<span className="rate">{sent ? pct(rate({ sent, replies })) : ""}</span></span>
        </button>; })}
      <button className="btn gh" disabled={!!busy || steps.length >= 12} onClick={addStep}><Icon n="plus" />Mail hinzufügen</button>
    </div>
    <div className="doc">
      <div className="row3" style={{ gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <label className="fld" style={{ width: 90 }}><span>Tag</span><input className="inp num" inputMode="numeric" value={steps[step].day} onChange={e => setStep({ day: Number(e.target.value.replace(/\D/g, "")) || 0 })} /></label>
        <label className="fld" style={{ flex: 1, minWidth: 160 }}><span>Name</span><input className="inp" value={steps[step].name} onChange={e => setStep({ name: e.target.value })} /></label>
      </div>
      <div className="seg" style={{ marginBottom: 12 }}>
        {vs.map(x => <button key={x.id} className={x.id === cur?.id ? "on" : ""} onClick={() => setK(x.key)}>{x.key}{!x.active && " (pausiert)"}</button>)}
        <button onClick={() => add("variant")} disabled={!!busy} aria-label="Leere Variante"><Icon n="plus" /></button>
        <button onClick={() => add("propose")} disabled={!!busy} aria-label="Variante von der KI">{busy === "propose" ? <Icon n="loader" /> : <Icon n="sparkles" />}</button>
      </div>
      {cur && <>
        <div className="vstats">
          <div><span className="l">Gesendet</span><span className="v">{cur.sent}</span></div>
          <div><span className="l">Antworten</span><span className="v">{cur.replies}</span></div>
          <div><span className="l">Quote</span><span className="v">{pct(rate(cur))}</span></div>
          <div><span className="l">Jev</span><span className="v" title={cur.score?.weakness}>{cur.score ? `${cur.score.reply.toFixed(1).replace(".", ",")} / 4` : "–"}</span></div>
          <div className="act">
            <div className="seg"><button className={cur.tone === "sie" ? "on" : ""} onClick={() => set({ tone: "sie" })}>Sie</button><button className={cur.tone === "du" ? "on" : ""} onClick={() => set({ tone: "du" })}>Du</button></div>
            <span className="f3">Aktiv</span><button className={`sw ${cur.active ? "on" : ""}`} aria-label="Variante aktiv" disabled={!!busy}
              onClick={() => act("tpl", () => api(`/api/sequences/templates/${cur.id}`, { method: "PUT", body: { active: !cur.active } }))} />
          </div>
        </div>
        {mode === "edit" ? <>
          <input className="subj" value={cur.subject} onChange={e => set({ subject: e.target.value })} aria-label="Betreff" />
          <textarea ref={ta} className="body" value={cur.body} onChange={e => { set({ body: e.target.value }); fit(e.target); }} aria-label="Text" />
          <div className="phs"><span className="f3" style={{ fontSize: 12 }}>Einfügen</span>{PH.map(p => <button key={p} className="ph" onClick={() => insert(p)}>{p}</button>)}</div>
        </> : <>
          <div className="subj">{fill(cur.subject, sample, cur, sender)}</div>
          <div className="pv">{fill(cur.body, sample, cur, sender)}{"\n\n--\nKeine weiteren Mails: …"}</div>
        </>}
        <div className="row3" style={{ gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button className="btn pri" disabled={!!busy} onClick={save}>Speichern</button>
          <div className="seg"><button className={mode === "edit" ? "on" : ""} onClick={() => setMode("edit")}>Bearbeiten</button><button className={mode === "preview" ? "on" : ""} onClick={() => setMode("preview")}>Vorschau</button></div>
          <button className="btn" disabled={!!busy} onClick={() => act("score", () => api(`/api/sequences/${s.id}`, { body: { action: "score", templateId: cur.id } }))}>
            {busy === "score" ? <Icon n="loader" /> : <Icon n="target" />}Mit Jev bewerten</button>
          <span className="sp" />
          {vs.length > 1 && <button className="btn gh" disabled={!!busy} onClick={() => confirm(`Variante ${cur.key} löschen?`) && act("del", () => api(`/api/sequences/templates/${cur.id}`, { method: "DELETE" }))}>Variante löschen</button>}
          {steps.length > 1 && step === steps.length - 1 && <button className="btn gh" disabled={!!busy} onClick={dropStep}>Mail löschen</button>}
        </div>
      </>}
    </div>
  </div>;
}

function People({ s }: { s: S }) {
  if (!s.people.length) return <div className="empty"><div><div className="h2">Noch niemand in der Strecke</div></div></div>;
  return <div className="tbl"><table className="t"><thead><tr><th>Name</th><th>E-Mail</th><th className="hide-m">Firma</th><th>Registriert</th><th>Mails</th><th>Status</th></tr></thead><tbody>
    {s.people.map(p => <tr key={p.id}>
      <td>{who(p)}</td><td>{p.email}</td><td className="hide-m">{p.company}</td><td className="num">{day(p.startedAt)}</td>
      <td className="num">{p.step} / {s.steps.length}</td>
      <td><span className={`pill ${p.status === "gekauft" ? "g" : ""}`}>{p.status === "aktiv" && p.step >= s.steps.length ? "Fertig" : STATUS[p.status] || p.status}</span></td>
    </tr>)}
  </tbody></table></div>;
}

function Settings({ s, ctx, act }: { s: S; ctx: Ctx; act: Act }) {
  const [c, setC] = useState(s.config), [name, setName] = useState(s.name);
  const m = (k: "enter" | "bought" | "stop", label: string) => <div className="row2">
    <label className="fld"><span>{label}: HubSpot-Eigenschaft</span><input className="inp" value={c[k].property} placeholder="interner Name" onChange={e => setC({ ...c, [k]: { ...c[k], property: e.target.value } })} /></label>
    <label className="fld"><span>Wert</span><input className="inp" value={c[k].value} placeholder="leer = beliebiger Wert" onChange={e => setC({ ...c, [k]: { ...c[k], value: e.target.value } })} /></label>
  </div>;
  const box = ctx.st.mailbox[c.senderId ?? 0];
  return <div className="form" style={{ maxWidth: 640 }}>
    <label className="fld"><span>Name</span><input className="inp" value={name} onChange={e => setName(e.target.value)} /></label>
    {m("enter", "Registriert")}
    {m("bought", "Pro gekauft")}
    {m("stop", "Keine Strecke")}
    <div className="row2">
      <label className="fld"><span>Absender</span><select className="inp" value={c.senderId ?? ""} onChange={e => setC({ ...c, senderId: Number(e.target.value) })}>
        {ctx.st.users.map(u => <option key={u.id} value={u.id}>{u.name}{ctx.st.mailbox[u.id] ? ` (${ctx.st.mailbox[u.id]})` : ""}</option>)}</select></label>
      <label className="fld"><span>Testphase in Tagen</span><input className="inp num" inputMode="numeric" value={c.trialDays} onChange={e => setC({ ...c, trialDays: Number(e.target.value.replace(/\D/g, "")) || 0 })} /></label>
    </div>
    <label className="fld"><span>Registriert ab</span><input className="inp" type="date" value={c.since.slice(0, 10)} onChange={e => e.target.value && setC({ ...c, since: new Date(`${e.target.value}T00:00:00`).toISOString() })} /></label>
    {c.senderId && !box && <div className="warn">Für diesen Absender ist kein Postfach verbunden.</div>}
    {c.senderId === ctx.st.me.id && box && !ctx.st.integ.outlook?.on && <div className="warn">Antworten erkennt die Strecke nur mit Microsoft 365.</div>}
    <div className="row3"><button className="btn pri" onClick={() => act("cfg", () => api(`/api/sequences/${s.id}`, { method: "PUT", body: { name, config: c } }), "Gespeichert")}>Speichern</button></div>
  </div>;
}
