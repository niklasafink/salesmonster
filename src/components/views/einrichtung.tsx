"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActionBarPrimitive, AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState, useExternalStoreRuntime, type AppendMessage } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { OPENROUTER_MODELS } from "@/lib/integ-meta";
import type { ChatMsg, SetupLead, SetupStep, SetupTemplate } from "@/db/schema";
import type { Setup } from "@/lib/setup";
import { Icon, Top, api } from "../ui";
import type { Ctx } from "../types";

/* Setup inside the portal. Only the chat follows claude.ai (assistant-ui's unstyled primitives); the left rail shows what will be stored,
   lists and mails open in a panel on the right, both in the portal's own look */

const STEPS: [SetupStep, string][] = [["website", "Unternehmen"], ["zielgruppe", "Zielgruppe"], ["ansprechpartner", "Ansprechpartner"], ["liste", "Erste Liste"], ["ansprache", "Ansprache"], ["fertig", "Übernehmen"]];
const NAME = Object.fromEntries(STEPS) as Record<SetupStep, string>;
const BUSY: Record<SetupStep, string> = { website: "Lese die Website", zielgruppe: "Leite Zielgruppen ab", ansprechpartner: "Ordne Rollen zu", liste: "Suche Firmen und Ansprechpartner", ansprache: "Schreibe Mails", fertig: "" };

type Res = { setup: Setup; prompt: string; ai?: boolean };
type Art = "liste" | "ansprache" | "fertig";

const convert = (m: ChatMsg, i: number) => ({ id: String(i), role: m.role === "ai" ? "assistant" as const : "user" as const, content: m.text });

export function Einrichtung({ ctx }: { ctx: Ctx }) {
  const t = ctx.st.tenant!;
  const [su, setSu] = useState<Setup | null>(null), [prompt, setPrompt] = useState(""), [ai, setAi] = useState(true);
  const [busy, setBusy] = useState(false), [auto, setAuto] = useState(false);
  const [art, setArt] = useState<Art | null>(null), [rail, setRail] = useState(false);
  const started = useRef<string>(""), stop = useRef(false);

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

  /* Steps with something to look at open their artifact once */
  const step = su?.step;
  useEffect(() => { if (step === "liste" || step === "ansprache" || step === "fertig") setArt(step); else setArt(null); }, [step]);

  async function runAuto() {
    setAuto(true); stop.current = false;
    let cur = su;
    while (cur && cur.step !== "fertig" && !stop.current) cur = await post({ action: "auto" });
    setAuto(false);
  }
  const send = useCallback(async (msg: string) => {
    if (!msg.trim()) return;
    setSu(s => s && { ...s, chat: [...s.chat, { role: "me", text: msg, step: s.step }] });
    await post({ action: "message", text: msg });
  }, [post]);
  const goto = (k: SetupStep) => { setRail(false); if (k !== step) post({ action: "goto", step: k }); };

  const runtime = useExternalStoreRuntime({
    messages: su?.chat ?? [], convertMessage: convert, isRunning: busy, isDisabled: !ai || auto || step === "fertig",
    onNew: async (m: AppendMessage) => { const p = m.content.find(c => c.type === "text"); if (p?.type === "text") await send(p.text); },
  });

  if (!su) return <><Top title="Einrichtung" onMenu={ctx.openSidebar} /><div className="cl"><main className="cl-main" /></div></>;

  const last = [...su.chat].reverse().find(m => m.role === "ai" && m.step === su.step);
  const card = su.step === "liste" && su.leads.length ? ["liste", "Erste Liste", `${su.leads.length} Firmen`] as const
    : su.step === "ansprache" && su.templates.length ? ["ansprache", "Mails", `${su.templates.length} Varianten`] as const
    : su.step === "fertig" ? ["fertig", "Übernehmen", ""] as const : null;

  return <>
    <Top title="Einrichtung" onMenu={ctx.openSidebar}>
      <span className="f3 cl-step">{NAME[su.step]}</span>
      <button className="btn gh ic cl-mob" onClick={() => setRail(true)} aria-label="Ergebnisse anzeigen"><Icon n="file-text" /></button>
    </Top>
  <div className={`cl ${art ? "art" : ""} ${rail ? "rail" : ""}`}>
    <aside className="cl-rail">
      <Rail su={su} busy={busy} goto={goto} open={a => { setArt(a); setRail(false); }} />
      <div className="cl-rf">
        {ai && su.step !== "fertig" && (auto
          ? <button className="btn sec" onClick={() => { stop.current = true; }}><Icon n="square" />Automatik anhalten</button>
          : <button className="btn sec" onClick={runAuto} disabled={busy}><Icon n="sparkles" />Rest automatisch</button>)}
        <button className="btn pri" onClick={() => su.step === "fertig" ? setArt("fertig") : goto("fertig")} disabled={busy}>Übernehmen</button>
      </div>
    </aside>
    {rail && <div className="cl-scrim" onClick={() => setRail(false)} />}

    <main className="cl-main">
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root className="cl-thread">
          <ThreadPrimitive.Viewport className="cl-vp">
            {!ai && <div className="cl-col"><Connect ctx={ctx} onDone={load} /></div>}
            <ThreadPrimitive.Messages>{() => <Msg />}</ThreadPrimitive.Messages>
            {su.step === "fertig" && <div className="cl-col cl-ai"><p>Fertig. Links steht, was ins Tool übernommen wird. Du kannst jeden Teil abwählen oder später unter Einstellungen ändern.</p></div>}
            {busy && <div className="cl-col cl-run"><Spark spin />{BUSY[su.step]}{su.step === "website" ? ` ${t.domain}` : ""}</div>}
            {card && !busy && <div className="cl-col"><button className={`cl-card ${art === card[0] ? "on" : ""}`} onClick={() => setArt(art === card[0] ? null : card[0])}>
              <span className="cl-ct"><Icon n={card[0] === "liste" ? "users" : card[0] === "ansprache" ? "mail" : "check"} /></span>
              <span className="cl-cn"><b>{card[1]}</b>{card[2] && <span>{card[2]}</span>}</span>
            </button></div>}
            <ThreadPrimitive.ViewportFooter className="cl-foot">
              {ai && su.step !== "fertig" && <>
                {!busy && !auto && last?.chips?.length ? <div className="cl-chips">{last.chips.map(c => <button key={c} onClick={() => send(c)}>{c}</button>)}</div> : null}
                <ComposerPrimitive.Root className="cl-comp">
                  <ComposerPrimitive.Input rows={1} autoFocus placeholder={auto ? "Läuft automatisch" : "Antworten"} aria-label="Antwort" className="cl-in" />
                  <div className="cl-cbar">
                    <button type="button" className="cl-tb" disabled={busy || auto} onClick={() => post({ action: "skip" })}>Überspringen</button>
                    <span className="sp" />
                    <button type="button" className="cl-tb" disabled={busy || auto} onClick={() => post({ action: "next" })}>Weiter zu {NAME[STEPS[STEPS.findIndex(([k]) => k === su.step) + 1][0]]}</button>
                    {auto
                      ? <button type="button" className="cl-send" onClick={() => { stop.current = true; }} aria-label="Anhalten"><i className="cl-stop" /></button>
                      : <ComposerPrimitive.Send className="cl-send" aria-label="Senden"><Icon n="arrow-up" /></ComposerPrimitive.Send>}
                  </div>
                </ComposerPrimitive.Root>
              </>}
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </main>

    {art && <section className="cl-art">
      <div className="top"><h1>{art === "liste" ? "Erste Liste" : art === "ansprache" ? "Mails" : "Übernehmen"}</h1>
        <span className="sp" /><button className="btn gh ic" onClick={() => setArt(null)} aria-label="Schließen"><Icon n="x" /></button></div>
      <div className="cl-ab">
        {art === "liste" ? <LeadList su={su} busy={busy} post={post} send={send} />
          : art === "ansprache" ? <Mails xs={su.templates} />
          : <Finish ctx={ctx} su={su} prompt={prompt} setPrompt={setPrompt} />}
      </div>
    </section>}
  </div>
  </>;
}

/* claude.ai: user turns in a bubble on the right, assistant turns as plain serif text with a copy action on hover */
function Msg() {
  const role = useAuiState(s => s.message.role);
  if (role === "user") return <MessagePrimitive.Root className="cl-col cl-me"><div><MessagePrimitive.Parts>{({ part }) => part.type === "text" ? <MarkdownTextPrimitive className="cl-md" /> : null}</MessagePrimitive.Parts></div></MessagePrimitive.Root>;
  return <MessagePrimitive.Root className="cl-col cl-ai">
    <MessagePrimitive.Parts>{({ part }) => part.type === "text" ? <MarkdownTextPrimitive className="cl-md" /> : null}</MessagePrimitive.Parts>
    <ActionBarPrimitive.Root className="cl-acts"><ActionBarPrimitive.Copy className="cl-ib" aria-label="Kopieren"><Icon n="copy" /></ActionBarPrimitive.Copy></ActionBarPrimitive.Root>
  </MessagePrimitive.Root>;
}

function Spark({ spin }: { spin?: boolean }) {
  return <svg className={`cl-spark ${spin ? "spin" : ""}`} viewBox="0 0 24 24" aria-hidden="true">
    {[0, 30, 60, 90, 120, 150].map(a => <rect key={a} x="11" y="2" width="2" height="20" rx="1" transform={`rotate(${a} 12 12)`} />)}
  </svg>;
}

/* What ends up in the tool: the same fields buildPrompt and applySetup read */
function Rail({ su, busy, goto, open }: { su: Setup; busy: boolean; goto: (k: SetupStep) => void; open: (a: Art) => void }) {
  const p = su.profile, idx = STEPS.findIndex(([k]) => k === su.step);
  const good = su.leads.filter(l => l.vote === 1).length, bad = su.leads.filter(l => l.vote === -1).length;
  const body: Record<SetupStep, React.ReactNode> = {
    website: p && <>
      {p.summary && <p>{p.summary}</p>}
      <Field l="Angebot" v={p.offer} /><Field l="Nutzen" v={p.valueProps} /><Field l="Belege" v={p.proof} />
      <Field l="Ansprache" v={p.language === "du" ? "Du" : p.language ? "Sie" : ""} /><Field l="Regionen" v={p.regions.join(", ")} />
    </>,
    zielgruppe: su.segments.length > 0 && su.segments.map(x => <div key={x.name} className="cl-item"><b>{x.name}</b>
      <span>{[x.industries.join(", "), x.size && `${x.size} Mitarbeitende`, x.regions.join(", ")].filter(Boolean).join(" · ")}</span>
      {x.why && <p>{x.why}</p>}</div>),
    ansprechpartner: su.personas.length > 0 && su.personas.map(x => <div key={x.role} className="cl-item"><b>{x.role}</b><span>{x.titles.join(", ")}</span></div>),
    liste: su.leads.length > 0 && <button className="cl-link" onClick={() => open("liste")}>{su.leads.length} Firmen{su.leads.length ? `, ${good} passen, ${bad} nicht` : ""}</button>,
    ansprache: su.templates.length > 0 && su.templates.map(x => <button key={x.key} className="cl-item cl-link" onClick={() => open("ansprache")}><b>{x.key} · {x.name}</b><span>{x.subject}</span></button>),
    fertig: null,
  };
  return <div className="cl-rs">{STEPS.slice(0, -1).map(([k, n], i) => {
    const cur = k === su.step, skipped = su.skipped.includes(k), content = body[k];
    return <section key={k} className={`cl-sec ${cur ? "on" : ""}`}>
      <button className="cl-sh" onClick={() => goto(k)} disabled={busy}>
        {cur ? <i className="cl-dot" /> : i < idx && !skipped ? <Icon n="check" /> : <i className="cl-dot off" />}{n}{skipped && <span className="cl-skip">übersprungen</span>}
      </button>
      {content && <div className="cl-sb" key={JSON.stringify(k === "website" ? p : k === "zielgruppe" ? su.segments : k === "ansprechpartner" ? su.personas : k === "liste" ? [su.leads.length, good, bad] : su.templates.map(x => x.subject))}>{content}</div>}
    </section>;
  })}</div>;
}

function Field({ l, v }: { l: string; v: string | string[] }) {
  if (Array.isArray(v) ? !v.length : !v) return null;
  return <div className="cl-f"><span>{l}</span>{Array.isArray(v) ? <ul>{v.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p>{v}</p>}</div>;
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
  return <div className="cl-ai">
    <p>Ich richte mit dir den Vertrieb für {t.name} ein. Dafür brauche ich zuerst Zugang zu einem Sprachmodell. Am einfachsten ist OpenRouter: ein Schlüssel für Claude, Gemini und GPT, abgerechnet nach Verbrauch.</p>
    <form className="cl-connect" onSubmit={go}>
      <div className="seg"><button type="button" className={kind === "openrouter" ? "on" : ""} onClick={() => setKind("openrouter")}>OpenRouter</button>
        <button type="button" className={kind === "claude" ? "on" : ""} onClick={() => setKind("claude")}>Claude-API</button></div>
      <label className="fld"><span>API-Schlüssel</span><input className="inp" type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)}
        placeholder={kind === "openrouter" ? "sk-or-…" : "sk-ant-…"} autoFocus /></label>
      {kind === "openrouter" && <label className="fld"><span>Modell</span><select className="inp" value={model} onChange={e => setModel(e.target.value)}>
        {OPENROUTER_MODELS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select></label>}
      {err && <div className="warn">{err}</div>}
      <div className="row3"><button className="btn pri" disabled={busy || !key.trim()}>{busy && <Icon n="loader" />}Verbinden</button>
        <a className="btn sec" href={kind === "openrouter" ? "https://openrouter.ai/settings/keys" : "https://console.anthropic.com/settings/keys"} target="_blank" rel="noreferrer">Schlüssel erstellen<Icon n="external-link" /></a></div>
    </form>
  </div>;
}

type Post = (b: Record<string, unknown>) => Promise<Setup | null>;

function LeadList({ su, busy, post, send }: { su: Setup; busy: boolean; post: Post; send: (m: string) => Promise<void> }) {
  const [rows, setRows] = useState<SetupLead[]>(su.leads);
  useEffect(() => setRows(su.leads), [su.leads]);
  const voted = rows.filter(r => r.vote).length;
  function vote(i: number, v: 1 | -1) {
    const next = rows.map((r, k) => k === i ? { ...r, vote: r.vote === v ? undefined : v, reason: r.vote === v ? "" : r.reason } : r);
    setRows(next); post({ action: "votes", leads: next });
  }
  return <>
    <div className="cl-leads">{rows.map((r, i) => <div key={r.company} className={`cl-lead ${r.vote === -1 ? "out" : ""}`}>
      <div className="cl-lh">
        <b className="cl-co">{r.website ? <a href={r.website.startsWith("http") ? r.website : `https://${r.website}`} target="_blank" rel="noreferrer">{r.company}</a> : r.company}</b>
        <div className="cl-vote">
          <button className={`btn gh ic ${r.vote === 1 ? "up" : ""}`} aria-label="Passt" aria-pressed={r.vote === 1} onClick={() => vote(i, 1)}><Icon n="thumbs-up" /></button>
          <button className={`btn gh ic ${r.vote === -1 ? "down" : ""}`} aria-label="Passt nicht" aria-pressed={r.vote === -1} onClick={() => vote(i, -1)}><Icon n="thumbs-down" /></button>
        </div>
      </div>
      <div className="f2">{r.person ? <>{r.linkedin ? <a href={r.linkedin} target="_blank" rel="noreferrer">{r.person}</a> : r.person}{r.role && `, ${r.role}`}</> : "Kein Ansprechpartner"}{r.segment && ` · ${r.segment}`}</div>
      {r.why && <p>{r.why}</p>}
      {r.vote === -1 && <input className="inp" placeholder="Warum nicht?" value={r.reason || ""} onChange={e => setRows(rows.map((x, k) => k === i ? { ...x, reason: e.target.value } : x))}
        onBlur={() => post({ action: "votes", leads: rows })} />}
    </div>)}</div>
    <div><button className="btn sec" disabled={busy || !voted} onClick={() => send("Ich habe die Liste bewertet. Bitte eine neue Runde mit dem Feedback.")}>Neue Runde mit Feedback</button></div>
  </>;
}

function Mails({ xs }: { xs: SetupTemplate[] }) {
  return <>{xs.map(x => <div key={x.key} className="doc">
    <div className="cl-mh"><span className="vc">{x.key}</span><b>{x.name}</b>{x.score && <span className="f3 num">Antwort {x.score.reply.toFixed(1).replace(".", ",")} von 4</span>}</div>
    <div className="subj">{x.subject}</div><div className="pv">{x.body}</div>
    {x.score?.weakness && !/no clear/i.test(x.score.weakness) && <div className="cl-mw f2">{x.score.weakness}</div>}
  </div>)}</>;
}

function Finish({ ctx, su, prompt, setPrompt }: { ctx: Ctx; su: Setup; prompt: string; setPrompt: (s: string) => void }) {
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
  return <>
    <div className="list-box">
      {row("prompt", "Zielgruppe für die Abendrecherche", !su.segments.length)}
      {row("templates", `${su.templates.length} Vorlagen`, !su.templates.length)}
      {row("leads", `${good} positiv bewertete Leads`, !good)}
    </div>
    {o.prompt && su.segments.length > 0 && <textarea className="prompt" value={prompt} onChange={e => setPrompt(e.target.value)} aria-label="Recherche-Prompt" />}
    <div><button className="btn pri" onClick={go} disabled={busy || !(o.prompt && su.segments.length || o.templates && su.templates.length || o.leads && good)}>{busy && <Icon n="loader" />}Übernehmen</button></div>
  </>;
}
