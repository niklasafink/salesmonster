"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MailScore, SeqConfig, SeqStep } from "@/db/schema";
import { fill, type FillLead } from "@/lib/fill";
import { Icon, Top, api, pct, rate, useAutosize } from "../ui";
import type { Ctx } from "../types";

type V = { id: number; step: number; key: string; tone: string; subject: string; body: string; active: boolean; score: MailScore | null; sent: number; replies: number; bounced: number };
type P = { id: number; email: string; first: string; last: string; company: string; salutation: string; startedAt: string; step: number; status: string; lastSentAt: string | null; repliedAt: string | null };
type S = { id: number; name: string; active: boolean; steps: SeqStep[]; config: SeqConfig; templates: V[]; people: P[]; waiting: P[]; counts: Record<string, number>; flow: F[] };
type F = { at: string; status: string; sent: number[]; replied: number[] };

const PH = ["{{anrede}}", "{{vorname}}", "{{nachname}}", "{{firma}}", "{{absender}}"];
const SAMPLE: FillLead = { company: "Muster Bau GmbH", first: "Katrin", last: "Albers", salutation: "Frau", emailType: "person", hook: "", tenders: [] };
const STATUS: Record<string, string> = { aktiv: "Aktiv", antwort: "Antwort", beendet: "Beendet", gekauft: "Pro gekauft", abgemeldet: "Abgemeldet", unzustellbar: "Unzustellbar" };
const day = (iso: string | null) => iso ? new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "";
const PERIODS: [string, string][] = [["10", "10 Tage"], ["30", "30 Tage"], ["90", "Quartal"], ["all", "Seit Start"]];
const who = (p: P) => [p.first, p.last].filter(Boolean).join(" ") || p.email;

export function Strecken({ ctx }: { ctx: Ctx }) {
  const { st } = ctx, t = st.tenant!;
  const [s, setS] = useState<S | null | undefined>(undefined);
  const [pane, setPane] = useState<"auswertung" | "mail" | "kontakte" | "einstellungen">("auswertung");
  const [i, setI] = useState(0);
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

  if (s === undefined) return <Top title="Inbound" onMenu={ctx.openSidebar} />;
  if (!s) return <>
    <Top title="Inbound" onMenu={ctx.openSidebar} />
    <div className="empty"><div><div className="h2">Noch keine Strecke</div>
      <button className="btn pri" disabled={!!busy} onClick={() => act("new", () => api(`/api/sequences?t=${encodeURIComponent(t.slug)}`, { method: "POST" }))}><Icon n="plus" />Strecke anlegen</button></div></div>
  </>;

  const put = (b: object) => api(`/api/sequences/${s.id}`, { method: "PUT", body: b });

  return <>
    <Top title={s.name} onMenu={ctx.openSidebar}>
      {s.active && <button className="btn" disabled={!!busy} onClick={() => act("run", async () => { const r = await api<{ info: string }>(`/api/sequences/${s.id}`, { body: { action: "run" } }); ctx.toast(r.info); })}>
        {busy === "run" ? <Icon n="loader" /> : <Icon n="send" />}Jetzt ausführen</button>}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}><span className="f3">Aktiv</span><button className={`sw ${s.active ? "on" : ""}`} aria-label="Strecke aktiv" disabled={!!busy}
        onClick={() => act("active", () => put({ active: !s.active }), s.active ? "Strecke pausiert" : "Strecke läuft")} /></span>
    </Top>
    <div className="inb">
      <nav className="subnav" aria-label="Inbound">
        <button className={pane === "auswertung" ? "on" : ""} aria-current={pane === "auswertung" ? "page" : undefined} onClick={() => setPane("auswertung")}><Icon n="layout-dashboard" />Auswertung</button>
        <div className="grp">Mails nach Registrierung</div>
        {s.steps.map((x, n) => { const sent = s.templates.filter(y => y.step === n).reduce((a, y) => a + y.sent, 0), on = pane === "mail" && i === n;
          return <button key={n} className={on ? "on" : ""} aria-current={on ? "page" : undefined} onClick={() => { setPane("mail"); setI(n); }}>
            <span className="vc">{n + 1}</span><span className="nm">{x.name || `Mail ${n + 1}`}</span><span className="cnt">{n === 0 && x.day === 0 ? "sofort" : `Tag ${x.day}`}{sent ? ` · ${sent}` : ""}</span>
          </button>; })}
        <button className="add" disabled={!!busy || s.steps.length >= 12} onClick={() => act("step", async () => {
          const last = s.steps[s.steps.length - 1];
          await api(`/api/sequences/${s.id}`, { method: "PUT", body: { steps: [...s.steps, { day: last.day + 5, name: "Neue Mail" }] } });
          await api(`/api/sequences/${s.id}`, { body: { action: "variant", step: s.steps.length } });
          setPane("mail"); setI(s.steps.length);
        })}><Icon n="plus" />Mail hinzufügen</button>
        <div className="grp">Verwalten</div>
        <button className={pane === "kontakte" ? "on" : ""} aria-current={pane === "kontakte" ? "page" : undefined} onClick={() => setPane("kontakte")}><Icon n="users" />Kontakte<span className="cnt">{s.people.length || ""}</span></button>
        <button className={pane === "einstellungen" ? "on" : ""} aria-current={pane === "einstellungen" ? "page" : undefined} onClick={() => setPane("einstellungen")}><Icon n="settings-2" />Einstellungen</button>
      </nav>
      <div className="scroll"><div className="wrap">
        {s.waiting.length > 0 && <Waiting s={s} busy={!!busy} act={act} />}
        {pane === "auswertung" ? <Funnel s={s} onStep={n => { setI(n); setPane("mail"); }} />
          : pane === "mail" ? <Mails key={s.id} s={s} ctx={ctx} act={act} busy={busy} step={Math.min(i, s.steps.length - 1)} onStep={setI} />
          : pane === "kontakte" ? <People s={s} />
          : <Settings key={s.id} s={s} ctx={ctx} act={act} />}
      </div></div>
    </div>
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

function Mails({ s, ctx, act, busy, step, onStep }: { s: S; ctx: Ctx; act: Act; busy: string; step: number; onStep: (n: number) => void }) {
  const [k, setK] = useState("A"), [mode, setMode] = useState<"edit" | "preview">("edit");
  const [list, setList] = useState(s.templates), [steps, setSteps] = useState(s.steps);
  const ta = useRef<HTMLTextAreaElement>(null), fit = useAutosize();
  useEffect(() => { setList(s.templates); setSteps(s.steps); }, [s]);
  useEffect(() => { fit(ta.current); });
  useEffect(() => { setK("A"); }, [step]);
  const vs = list.filter(x => x.step === step);
  const cur = vs.find(x => x.key === k) || vs[0];
  const sender = ctx.st.users.find(u => u.id === s.config.senderId)?.name || ctx.st.me.name;
  const sample: FillLead = s.people[0] ? { ...SAMPLE, ...s.people[0] } : SAMPLE;
  const set = (p: Partial<V>) => cur && setList(ls => ls.map(x => x.id === cur.id ? { ...x, ...p } : x));
  const setStep = (p: Partial<SeqStep>) => setSteps(ss => ss.map((x, n) => n === step ? { ...x, ...p } : x));
  /* with two or more variants that have been sent, the one with the best answer rate is marked */
  const lead = vs.filter(x => x.sent > 0).length > 1 ? vs.reduce((a, x) => rate(x) > rate(a) ? x : a, vs[0]) : null;

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
  const dropStep = () => confirm(`Mail ${steps.length} mit allen Varianten löschen?`) && act("drop", async () => {
    await api(`/api/sequences/${s.id}`, { method: "PUT", body: { steps: steps.slice(0, -1) } }); onStep(steps.length - 2);
  });

  return <div className="mailed">
    <div className="mhead">
      <span className="vc">{step + 1}</span>
      <label className="fld" style={{ flex: 1, minWidth: 160 }}><span>Name der Mail</span><input className="inp" value={steps[step].name} onChange={e => setStep({ name: e.target.value })} /></label>
      <label className="fld" style={{ width: 130 }}><span>Tage nach Registrierung</span><input className="inp num" inputMode="numeric" value={steps[step].day} onChange={e => setStep({ day: Number(e.target.value.replace(/\D/g, "")) || 0 })} /></label>
    </div>
    <div>
      <div className="mlabel">A/B-Test: Varianten dieser Mail<span className="f3"> · jede Person bekommt eine Variante, gewinnende werden öfter ausgespielt</span></div>
      <div className="vcards">
        {vs.map(x => <button key={x.id} className={`vcard ${x.id === cur?.id ? "on" : ""} ${x.active ? "" : "off"}`} onClick={() => setK(x.key)}>
          <span className="top2"><b>Variante {x.key}</b>{!x.active && <span className="pill">pausiert</span>}{lead?.id === x.id && <span className="pill g">vorn</span>}</span>
          <span className="big">{x.sent ? pct(rate(x)) : "–"}</span>
          <span className="f3">{x.replies} Antworten · {x.sent} gesendet</span>
        </button>)}
        <button className="vcard add" onClick={() => add("variant")} disabled={!!busy}><Icon n="plus" />Leere Variante</button>
        <button className="vcard add" onClick={() => add("propose")} disabled={!!busy}>{busy === "propose" ? <Icon n="loader" /> : <Icon n="sparkles" />}Variante von der KI</button>
      </div>
    </div>
    {cur && <div className="doc">
      <div className="vstats">
        <div><span className="l">Jev</span><span className="v" title={cur.score?.weakness}>{cur.score ? `${cur.score.reply.toFixed(1).replace(".", ",")} / 4` : "–"}</span></div>
        <div className="act">
          <div className="seg"><button className={cur.tone === "sie" ? "on" : ""} onClick={() => set({ tone: "sie" })}>Sie</button><button className={cur.tone === "du" ? "on" : ""} onClick={() => set({ tone: "du" })}>Du</button></div>
          <span className="f3">Variante aktiv</span><button className={`sw ${cur.active ? "on" : ""}`} aria-label="Variante aktiv" disabled={!!busy}
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
      <div className="row3" style={{ gap: 8, padding: "12px 16px 16px", flexWrap: "wrap" }}>
        <button className="btn pri" disabled={!!busy} onClick={save}>Speichern</button>
        <div className="seg"><button className={mode === "edit" ? "on" : ""} onClick={() => setMode("edit")}>Bearbeiten</button><button className={mode === "preview" ? "on" : ""} onClick={() => setMode("preview")}>Vorschau</button></div>
        <button className="btn" disabled={!!busy} onClick={() => act("score", () => api(`/api/sequences/${s.id}`, { body: { action: "score", templateId: cur.id } }))}>
          {busy === "score" ? <Icon n="loader" /> : <Icon n="target" />}Mit Jev bewerten</button>
        <span className="sp" />
        {vs.length > 1 && <button className="btn gh" disabled={!!busy} onClick={() => confirm(`Variante ${cur.key} löschen?`) && act("del", () => api(`/api/sequences/templates/${cur.id}`, { method: "DELETE" }))}>Variante löschen</button>}
        {steps.length > 1 && step === steps.length - 1 && <button className="btn gh" disabled={!!busy} onClick={dropStep}>Mail löschen</button>}
      </div>
    </div>}
  </div>;
}

/* The pipeline: who registered in the period, and for each mail how many got it, how many wait for it, how many answered, per variant */
function Funnel({ s, onStep }: { s: S; onStep: (n: number) => void }) {
  const [period, setPeriod] = useState("30");
  const f = useMemo(() => {
    const now = Date.now(), from = period === "all" ? 0 : now - Number(period) * 864e5;
    const ppl = s.flow.filter(p => new Date(p.at).getTime() >= from);
    const open = s.people.filter(p => p.status === "aktiv");
    const steps = s.steps.map((x, n) => {
      const wait = open.filter(p => p.step === n), due = wait.filter(p => new Date(p.startedAt).getTime() + x.day * 864e5 <= now);
      return { ...x, sent: ppl.filter(p => p.sent.includes(n)).length, replied: ppl.filter(p => p.replied.includes(n)).length, wait: wait.length, due: due.length,
        vars: s.templates.filter(v => v.step === n && (v.active || v.sent)) };
    });
    /* registrations per day over the last 14 days */
    const days = Array.from({ length: 14 }, (_, d) => { const at = new Date(now - (13 - d) * 864e5), key = at.toDateString();
      return { at, n: s.flow.filter(p => new Date(p.at).toDateString() === key).length }; });
    return { n: ppl.length, reached: ppl.filter(p => p.sent.length).length, replied: ppl.filter(p => p.replied.length).length, bought: ppl.filter(p => p.status === "gekauft").length, steps, days };
  }, [s, period]);
  const q = (a: number, b: number) => b ? pct(a / b * 100) : "–";
  const peak = Math.max(1, ...f.days.map(d => d.n));
  return <>
    <div className="row3"><div className="seg">{PERIODS.map(([k, n]) => <button key={k} className={period === k ? "on" : ""} aria-pressed={period === k} onClick={() => setPeriod(k)}>{n}</button>)}</div></div>
    <div className="kpis">
      <div className="kpi"><span className="l">Registriert</span><span className="v">{f.n}</span></div>
      <div className="kpi"><span className="l">Angeschrieben</span><span className="v">{f.reached}</span></div>
      <div className="kpi"><span className="l">Geantwortet</span><span className="v">{f.replied}<span className="f3" style={{ fontSize: 14, fontWeight: 500 }}> {q(f.replied, f.reached)}</span></span></div>
      <div className="kpi"><span className="l">Pro gekauft</span><span className="v">{f.bought}<span className="f3" style={{ fontSize: 14, fontWeight: 500 }}> {q(f.bought, f.n)}</span></span></div>
    </div>
    <div>
      <div className="mlabel">Neue Registrierungen pro Tag<span className="f3"> · letzte 14 Tage</span></div>
      <div className="days">{f.days.map((d, n) => <div key={n} title={`${day(d.at.toISOString())}: ${d.n}`}><span className="n">{d.n || ""}</span><i style={{ height: `${d.n / peak * 100}%` }} /><span className="d">{d.at.getDate()}.</span></div>)}</div>
    </div>
    <div>
      <div className="mlabel">Pipeline<span className="f3"> · eine Zeile je Mail, ein Klick öffnet Text und A/B-Test</span></div>
      <div className="pipe">
        <div className="prow head"><span /><span>Mail</span><span className="rt">Gesendet</span><span className="rt hide-m">Wartet</span><span className="rt">Antworten</span><span className="hide-m">Varianten (Antwortquote)</span></div>
        {f.steps.map((x, n) => <button key={n} className="prow" onClick={() => onStep(n)}>
          <span className="vc">{n + 1}</span>
          <span className="pn"><b>{x.name || `Mail ${n + 1}`}</b><span className="f3">{x.day === 0 ? "bei Registrierung" : `Tag ${x.day}`}</span></span>
          <span className="rt num">{x.sent}</span>
          <span className="rt num hide-m">{x.wait ? <>{x.wait}{x.due > 0 && <span className="pill a" style={{ marginLeft: 6 }}>{x.due} fällig</span>}</> : <span className="f3">0</span>}</span>
          <span className="rt num">{x.replied}<span className="f3"> {q(x.replied, x.sent)}</span></span>
          <span className="pv2 hide-m">{x.vars.map(v => <span key={v.id} className={`pill ${v.active ? "" : "off"}`} title={`Variante ${v.key}: ${v.sent} gesendet, ${v.replies} Antworten`}>{v.key} {v.sent ? pct(rate(v)) : "–"}</span>)}</span>
        </button>)}
      </div>
    </div>
  </>;
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
  const m = (k: "enter" | "bought" | "stop", label: string) => <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
    <label className="fld"><span>{label}: HubSpot-Eigenschaft</span><input className="inp" value={c[k].property} placeholder="interner Name" onChange={e => setC({ ...c, [k]: { ...c[k], property: e.target.value } })} /></label>
    <label className="fld"><span>Wert</span><input className="inp" value={c[k].value} placeholder="leer = beliebiger Wert" onChange={e => setC({ ...c, [k]: { ...c[k], value: e.target.value } })} /></label>
  </div>;
  const box = ctx.st.mailbox[c.senderId ?? 0];
  return <div className="form" style={{ maxWidth: 640 }}>
    <label className="fld"><span>Name</span><input className="inp" value={name} onChange={e => setName(e.target.value)} /></label>
    {m("enter", "Registriert")}
    {m("bought", "Pro gekauft")}
    {m("stop", "Keine Strecke")}
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
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
