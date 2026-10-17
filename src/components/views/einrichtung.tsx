"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { OPENROUTER_MODELS } from "@/lib/integ-meta";
import type { Persona, Profile, Segment, SetupLead, SetupStep, SetupTemplate } from "@/db/schema";
import type { Setup } from "@/lib/setup";
import { Icon, Top, api } from "../ui";
import type { Ctx } from "../types";

const STEPS: [SetupStep, string][] = [["website", "Website"], ["zielgruppe", "Zielgruppe"], ["ansprechpartner", "Ansprechpartner"], ["liste", "Erste Liste"], ["ansprache", "Ansprache"], ["fertig", "Übernehmen"]];
const BUSY: Record<SetupStep, string> = { website: "Lese die Website", zielgruppe: "Leite Zielgruppen ab", ansprechpartner: "Ordne Rollen zu", liste: "Suche Firmen und Ansprechpartner", ansprache: "Schreibe Mails", fertig: "" };

type Res = { setup: Setup; prompt: string; ai?: boolean };

export function Einrichtung({ ctx }: { ctx: Ctx }) {
  const t = ctx.st.tenant!;
  const [su, setSu] = useState<Setup | null>(null), [prompt, setPrompt] = useState(""), [ai, setAi] = useState(true);
  const [busy, setBusy] = useState(false), [auto, setAuto] = useState(false), [text, setText] = useState("");
  const started = useRef<string>(""), stop = useRef(false), end = useRef<HTMLDivElement>(null);

  const apply = useCallback((r: Res) => { setSu(r.setup); setPrompt(r.prompt); if (r.ai !== undefined) setAi(r.ai); }, []);
  const load = useCallback(() => api<Res>(`/api/setup?t=${t.slug}`).then(apply).catch(e => ctx.toast(e.message)), [t.slug, apply, ctx]);
  useEffect(() => { load(); }, [load]);

  const post = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    try { const r = await api<Res>("/api/setup", { body: { t: t.slug, ...body } }); apply(r); return r.setup; }
    catch (e) { ctx.toast((e as Error).message); return null; }
    finally { setBusy(false); }
  }, [t.slug, apply, ctx]);

  /* Entering a step the AI has not spoken in yet starts it */
  useEffect(() => {
    if (!su || !ai || busy || auto || su.step === "fertig") return;
    const key = `${su.id}:${su.step}`;
    if (started.current === key || su.chat.some(m => m.step === su.step && m.role === "ai")) return;
    started.current = key; post({ action: "start" });
  }, [su, ai, busy, auto, post]);

  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [su?.chat.length, busy]);

  async function runAuto() {
    setAuto(true); stop.current = false;
    let cur = su;
    while (cur && cur.step !== "fertig" && !stop.current) cur = await post({ action: "auto" });
    setAuto(false);
  }
  async function send(msg: string) {
    if (!msg.trim() || busy) return;
    setText("");
    setSu(s => s && { ...s, chat: [...s.chat, { role: "me", text: msg, step: s.step }] });
    await post({ action: "message", text: msg });
  }

  if (!su) return <><Top title="Einrichtung" onMenu={ctx.openSidebar} /><div className="scroll" /></>;

  const step = su.step, msgs = su.chat.filter(m => m.step === step);
  const last = [...msgs].reverse().find(m => m.role === "ai");
  const idx = STEPS.findIndex(([k]) => k === step);

  return <>
    <Top title="Einrichtung" onMenu={ctx.openSidebar}>
      <div className="ob-steps">{STEPS.map(([k, n], i) => <button key={k} className={`${k === step ? "on" : ""} ${i < idx ? "dn" : ""}`} disabled={busy}
        onClick={() => post({ action: "goto", step: k })}>{i < idx && !su.skipped.includes(k) ? <Icon n="check" /> : null}{n}</button>)}</div>
      <span className="ob-count num f3">{idx + 1}/{STEPS.length}</span>
      {step !== "fertig" && ai && (auto
        ? <button className="btn sec" onClick={() => { stop.current = true; }}><Icon n="square" />Anhalten</button>
        : <button className="btn sec" onClick={runAuto} disabled={busy}><Icon n="sparkles" />Automatisch</button>)}
    </Top>
    <div className="ob">
      <section className="ob-chat">
        <div className="ob-thread">
          {!ai ? <Connect ctx={ctx} onDone={load} /> : step === "fertig"
            ? <div className="ob-ai">Fertig. Rechts steht, was übernommen wird. Du kannst jeden Teil abwählen oder später unter Einstellungen ändern.</div>
            : <>
              {msgs.map((m, i) => <div key={i} className={m.role === "ai" ? "ob-ai" : "ob-me"}>{m.text}</div>)}
              {busy && <div className="ob-ai f3 ob-busy"><Icon n="loader" />{BUSY[step]}{step === "website" ? ` ${t.domain}` : ""}</div>}
            </>}
          <div ref={end} />
        </div>
        {ai && step !== "fertig" && <div className="ob-foot">
          {!busy && last?.chips?.length ? <div className="ob-chips">{last.chips.map(c => <button key={c} onClick={() => send(c)}>{c}</button>)}</div> : null}
          <form className="ob-comp" onSubmit={e => { e.preventDefault(); send(text); }}>
            <textarea value={text} rows={2} placeholder="Antworten" aria-label="Antwort" disabled={auto}
              onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }} />
            <div className="ob-bar">
              <button type="button" className="btn gh" disabled={busy} onClick={() => post({ action: "skip" })}>Überspringen</button>
              <span className="sp" />
              <button type="button" className="btn sec" disabled={busy} onClick={() => post({ action: "next" })}>Weiter<Icon n="arrow-right" /></button>
              <button className="btn pri ic" disabled={busy || !text.trim()} aria-label="Senden"><Icon n="arrow-up" /></button>
            </div>
          </form>
        </div>}
      </section>
      <section className="ob-panel">
        <Panel ctx={ctx} su={su} busy={busy} prompt={prompt} setPrompt={setPrompt} post={post} send={send} />
      </section>
    </div>
  </>;
}

/* Without any model nothing works, so this comes first */
function Connect({ ctx, onDone }: { ctx: Ctx; onDone: () => void }) {
  const t = ctx.st.tenant!;
  const [kind, setKind] = useState<"openrouter" | "claude">("openrouter"), [key, setKey] = useState(""), [model, setModel] = useState(OPENROUTER_MODELS[0][0]);
  const [busy, setBusy] = useState(false), [err, setErr] = useState("");
  async function go(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    try { await api("/api/integrations", { body: { t: t.slug, kind, values: kind === "openrouter" ? { key, model } : { key } } }); ctx.reload(); onDone(); }
    catch (x) { setErr((x as Error).message); }
    setBusy(false);
  }
  return <>
    <div className="ob-ai">Ich richte mit dir den Vertrieb für {t.name} ein. Dafür brauche ich zuerst Zugang zu einem Sprachmodell. Am einfachsten ist OpenRouter: ein Schlüssel für Claude, Gemini und GPT, abgerechnet nach Verbrauch.</div>
    <form className="ob-connect" onSubmit={go}>
      <div className="seg"><button type="button" className={kind === "openrouter" ? "on" : ""} onClick={() => setKind("openrouter")}>OpenRouter</button>
        <button type="button" className={kind === "claude" ? "on" : ""} onClick={() => setKind("claude")}>Claude-API</button></div>
      <label className="fld"><span>API-Schlüssel</span><input className="inp" type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)}
        placeholder={kind === "openrouter" ? "sk-or-…" : "sk-ant-…"} autoFocus /></label>
      {kind === "openrouter" && <label className="fld"><span>Modell</span><select className="inp" value={model} onChange={e => setModel(e.target.value)}>
        {OPENROUTER_MODELS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select></label>}
      {err && <div className="warn">{err}</div>}
      <div className="row3"><button className="btn pri" disabled={busy || !key.trim()}>{busy && <Icon n="loader" />}Verbinden</button>
        <a className="btn gh" href={kind === "openrouter" ? "https://openrouter.ai/settings/keys" : "https://console.anthropic.com/settings/keys"} target="_blank" rel="noreferrer">Schlüssel erstellen<Icon n="external-link" /></a></div>
    </form>
  </>;
}

type PanelProps = { ctx: Ctx; su: Setup; busy: boolean; prompt: string; setPrompt: (s: string) => void; post: (b: Record<string, unknown>) => Promise<Setup | null>; send: (m: string) => Promise<void> };

function Panel(p: PanelProps) {
  const { su, busy } = p;
  const empty = { website: !su.profile, zielgruppe: !su.segments.length, ansprechpartner: !su.personas.length, liste: !su.leads.length, ansprache: !su.templates.length, fertig: false }[su.step];
  if (empty) return busy ? <div className="ob-skel">{[0, 1, 2, 3, 4].map(i => <i key={i} style={{ width: `${90 - i * 12}%` }} />)}</div> : <div className="ob-none" />;
  switch (su.step) {
    case "website": return <ProfileView p={su.profile!} />;
    case "zielgruppe": return <Segments xs={su.segments} />;
    case "ansprechpartner": return <Personas xs={su.personas} />;
    case "liste": return <LeadList {...p} />;
    case "ansprache": return <Mails xs={su.templates} />;
    default: return <Finish {...p} />;
  }
}

function Props({ rows }: { rows: [string, React.ReactNode][] }) {
  return <dl className="ob-props">{rows.filter(([, v]) => Array.isArray(v) ? v.length : v).map(([l, v]) => <div key={l}><dt>{l}</dt>
    <dd>{Array.isArray(v) ? <ul>{v.map((x, i) => <li key={i}>{x}</li>)}</ul> : v}</dd></div>)}</dl>;
}

function ProfileView({ p }: { p: Profile }) {
  return <div className="ob-sec"><h2>{p.name}</h2><Props rows={[["Kurzprofil", p.summary], ["Angebot", p.offer], ["Nutzen", p.valueProps], ["Kunden", p.customers], ["Belege", p.proof],
    ["Regionen", p.regions.join(", ")], ["Ansprache", p.language === "du" ? "Du" : p.language ? "Sie" : ""], ["Preise", p.pricing]]} /></div>;
}

function Segments({ xs }: { xs: Segment[] }) {
  return <>{xs.map((x, i) => <div key={i} className="ob-sec"><h2>{x.name}</h2><Props rows={[["Warum", x.why], ["Branchen", x.industries.join(", ")], ["Größe", x.size ? `${x.size} Mitarbeitende` : ""],
    ["Regionen", x.regions.join(", ")], ["Anlässe", x.triggers], ["Ausschluss", x.exclude]]} /></div>)}</>;
}

function Personas({ xs }: { xs: Persona[] }) {
  return <>{xs.map((x, i) => <div key={i} className="ob-sec"><h2>{x.role}</h2><Props rows={[["Titel", x.titles.join(", ")], ["Segment", x.segment], ["Probleme", x.pains], ["Ziele", x.goals],
    ["Suche", x.query ? <a href={`https://www.google.com/search?q=${encodeURIComponent(x.query)}`} target="_blank" rel="noreferrer" className="mono ob-q">{x.query}<Icon n="external-link" /></a> : ""]]} /></div>)}</>;
}

function LeadList({ su, busy, post, send }: PanelProps) {
  const [rows, setRows] = useState<SetupLead[]>(su.leads);
  useEffect(() => setRows(su.leads), [su.leads]);
  const voted = rows.filter(r => r.vote).length;
  function vote(i: number, v: 1 | -1) {
    const next = rows.map((r, k) => k === i ? { ...r, vote: r.vote === v ? undefined : v, reason: r.vote === v ? "" : r.reason } : r);
    setRows(next); post({ action: "votes", leads: next });
  }
  return <div className="ob-sec wide">
    <div className="tbl"><table><thead><tr><th>Firma</th><th>Ansprechpartner</th><th className="hide-m">Segment</th><th className="hide-m">Grund</th><th /></tr></thead><tbody>
      {rows.map((r, i) => <tr key={r.company} className={r.vote === -1 ? "ob-out" : ""}>
        <td className="ob-co">{r.website ? <a href={r.website.startsWith("http") ? r.website : `https://${r.website}`} target="_blank" rel="noreferrer">{r.company}</a> : r.company}</td>
        <td>{r.person ? <>{r.linkedin ? <a href={r.linkedin} target="_blank" rel="noreferrer">{r.person}</a> : r.person}{r.role && <span className="f2">, {r.role}</span>}</> : <span className="f3">–</span>}</td>
        <td className="hide-m f2">{r.segment}</td>
        <td className="hide-m ob-why">{r.why}
          {r.vote === -1 && <input className="inp ob-reason" placeholder="Warum nicht?" value={r.reason || ""} onChange={e => setRows(rows.map((x, k) => k === i ? { ...x, reason: e.target.value } : x))}
            onBlur={() => post({ action: "votes", leads: rows })} />}</td>
        <td><div className="ob-vote">
          <button className={`btn gh ic ${r.vote === 1 ? "up" : ""}`} aria-label="Passt" aria-pressed={r.vote === 1} onClick={() => vote(i, 1)}><Icon n="thumbs-up" /></button>
          <button className={`btn gh ic ${r.vote === -1 ? "down" : ""}`} aria-label="Passt nicht" aria-pressed={r.vote === -1} onClick={() => vote(i, -1)}><Icon n="thumbs-down" /></button></div></td>
      </tr>)}
    </tbody></table></div>
    <div className="row3"><button className="btn sec" disabled={busy || !voted} onClick={() => send("Ich habe die Liste bewertet. Bitte eine neue Runde mit dem Feedback.")}>Neue Runde mit Feedback</button></div>
  </div>;
}

function Mails({ xs }: { xs: SetupTemplate[] }) {
  return <div className="ob-mails">{xs.map(x => <div key={x.key} className="doc">
    <div className="ob-mh"><span className="vc">{x.key}</span><b>{x.name}</b>{x.score && <span className="f3 num">Antwort {x.score.reply.toFixed(1).replace(".", ",")} von 4</span>}</div>
    <div className="subj">{x.subject}</div><div className="pv">{x.body}</div>
    {x.score?.weakness && !/no clear/i.test(x.score.weakness) && <div className="ob-mw f2">{x.score.weakness}</div>}
  </div>)}</div>;
}

function Finish({ ctx, su, prompt, setPrompt }: PanelProps) {
  const good = su.leads.filter(l => l.vote === 1).length;
  const [o, setO] = useState({ prompt: !!su.segments.length, templates: su.templates.length > 0, leads: good > 0 }), [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      const r = await api<{ applied: { prompt: boolean; templates: number; leads: number } }>("/api/setup", { body: { t: ctx.st.tenant!.slug, action: "apply", prompt: o.prompt ? prompt : "", templates: o.templates, leads: o.leads } });
      const a = r.applied;
      ctx.toast([a.prompt && "Zielgruppe", a.templates && `${a.templates} Vorlagen`, a.leads && `${a.leads} Leads`].filter(Boolean).join(", ") + " übernommen");
      await ctx.reload(); ctx.setView(a.leads ? "leads" : "einstellungen");
    } catch (e) { ctx.toast((e as Error).message); }
    setBusy(false);
  }
  const row = (k: keyof typeof o, label: string, dis: boolean) => <label className="row2"><span>{label}</span>
    <button className={`sw ${o[k] && !dis ? "on" : ""}`} disabled={dis} aria-label={label} onClick={e => { e.preventDefault(); setO({ ...o, [k]: !o[k] }); }} /></label>;
  return <div className="ob-sec">
    <div className="list-box">
      {row("prompt", "Zielgruppe für die Abendrecherche", !su.segments.length)}
      {row("templates", `${su.templates.length} Vorlagen`, !su.templates.length)}
      {row("leads", `${good} positiv bewertete Leads`, !good)}
    </div>
    {o.prompt && su.segments.length > 0 && <textarea className="prompt" value={prompt} onChange={e => setPrompt(e.target.value)} aria-label="Recherche-Prompt" />}
    <div><button className="btn pri" onClick={go} disabled={busy || !(o.prompt && su.segments.length || o.templates && su.templates.length || o.leads && good)}>{busy && <Icon n="loader" />}Übernehmen</button></div>
  </div>;
}
