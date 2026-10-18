"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActionBarPrimitive, AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState, useExternalStoreRuntime, type AppendMessage } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { OPENROUTER_MODELS } from "@/lib/integ-meta";
import type { SetupLead, SetupStep, SetupTemplate } from "@/db/schema";
import type { Setup } from "@/lib/setup";
import { httpUrl } from "@/lib/lead-fields";
import { Icon, Top, api, useDialog } from "../ui";
import type { Ctx } from "../types";

/* Setup inside the portal: the steps on the left, everything else happens in a chat in the claude.ai look (assistant-ui's unstyled primitives).
   New AI turns are typed out one after another, lists and mails appear inline below the last turn */

const STEPS: [SetupStep, string][] = [["website", "Unternehmen"], ["zielgruppe", "Zielgruppe"], ["ansprechpartner", "Ansprechpartner"], ["liste", "Erste Liste"], ["ansprache", "Ansprache"], ["fertig", "Übernehmen"]];
const NAME = Object.fromEntries(STEPS) as Record<SetupStep, string>;
const BUSY: Record<SetupStep, string> = { website: "Lese die Website", zielgruppe: "Leite Zielgruppen ab", ansprechpartner: "Ordne Rollen zu", liste: "Suche Firmen und Ansprechpartner", ansprache: "Schreibe Mails", fertig: "Übernehme" };
const CONNECT = "Bevor wir anfangen, brauche ich Zugriff auf eine KI. Füge hier deinen API-Schlüssel ein, von [OpenRouter](https://openrouter.ai/settings/keys) oder von der [Claude-API](https://console.anthropic.com/settings/keys).";

const NEW_KEY = "Anderen Schlüssel verbinden";

type Opt = { id: string; label: string };
type Res = { setup: Setup; parts: Record<SetupStep, string>; keys: Partial<Record<SetupStep, string>>; ai?: boolean; choose?: Opt[] | null };
type Line = { id: string; role: "ai" | "me"; text: string; chips?: string[] };

const convert = (l: Line) => ({ id: l.id, role: l.role === "ai" ? "assistant" as const : "user" as const, content: l.text });

export function Einrichtung({ ctx }: { ctx: Ctx }) {
  const t = ctx.st.tenant!;
  const [su, setSu] = useState<Setup | null>(null), [res, setRes] = useState<Res | null>(null), [ai, setAi] = useState(true);
  const [busy, setBusy] = useState(false), [rail, setRail] = useState(false), [started, setStarted] = useState(""), [open, setOpen] = useState<SetupStep | null>(null);
  const [local, setLocal] = useState<Line[]>([{ id: "connect", role: "ai", text: CONNECT }]);
  /* the account has keys but this tenant has not picked one yet: one question instead of a new setup */
  const [choose, setChoose] = useState<Opt[] | null>(null);

  const apply = useCallback((r: Res) => { setSu(r.setup); setRes(r); if (r.ai !== undefined) setAi(r.ai); if (r.choose !== undefined) setChoose(r.choose); }, []);
  const load = useCallback(() => api<Res>(`/api/setup?t=${t.slug}`).then(apply).catch(e => ctx.toast(e.message, { error: true })), [t.slug, apply, ctx]);
  useEffect(() => { load(); }, [load]);

  const post = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    try { const r = await api<Res>("/api/setup", { body: { t: t.slug, ...body } }); apply(r); return r.setup; }
    catch (e) { ctx.toast((e as Error).message, { error: true }); return null; }
    finally { setBusy(false); }
  }, [t.slug, apply, ctx]);

  const good = su ? su.leads.filter(l => l.vote === 1).length : 0;

  /* Server turns keyed by content, so trimming the history to 80 does not make old turns look new */
  const lines = useMemo(() => {
    if (!su) return [];
    const n = new Map<string, number>();
    const xs: Line[] = su.chat.map(m => { const k = `${m.role}:${m.step}:${m.text}`, c = n.get(k) ?? 0; n.set(k, c + 1); return { id: `${k}#${c}`, role: m.role, text: m.text, chips: m.chips }; });
    if (choose) xs.push({ id: "pick", role: "ai", text: `Welche KI soll ${t.name} nutzen?`, chips: [...choose.map(o => o.label), NEW_KEY] });
    else if (!ai) xs.push(...local);
    if (su.step === "fertig") {
      const what = [su.segments.length > 0 && "die Zielgruppe für die Abendrecherche", su.templates.length > 0 && `${su.templates.length} Vorlagen`, good > 0 && `${good} positiv bewertete Leads`].filter(Boolean) as string[];
      xs.push(what.length
        ? { id: "fertig", role: "ai", text: `Fertig. Ich übernehme ${what.length > 1 ? `${what.slice(0, -1).join(", ")} und ${what.at(-1)}` : what[0]}. Ändern kannst du das später unter Einstellungen.`, chips: ["Übernehmen"] }
        : { id: "fertig", role: "ai", text: "Es gibt noch nichts zu übernehmen. Wähle links einen Schritt, dann machen wir dort weiter." });
    }
    return xs;
  }, [su, ai, local, good, choose, t.name]);

  /* Typewriter: what was there on first load counts as read, every later AI turn is typed out in order */
  const [read, setRead] = useState<Set<string> | null>(null), [tp, setTp] = useState({ id: "", n: 0 });
  useEffect(() => { if (su && !read) setRead(new Set(lines.filter(l => l.id !== "connect" && l.id !== "fertig" && l.id !== "pick").map(l => l.id))); }, [su, read, lines]);
  const next = read ? lines.find(l => l.role === "ai" && !read.has(l.id)) : undefined;
  const typed = next && tp.id === next.id ? tp.n : 0;
  useEffect(() => {
    if (!next) return;
    const id = next.id, len = next.text.length;
    const tm = typed >= len
      ? setTimeout(() => setRead(r => new Set(r).add(id)), 0)
      : setTimeout(() => setTp({ id, n: Math.min(len, typed + 2 + Math.floor(Math.random() * 5)) }), 24);
    return () => clearTimeout(tm);
  }, [next, typed]);
  const shown = useMemo(() => {
    if (!read) return [];
    if (!next) return lines;
    return [...lines.slice(0, lines.indexOf(next)), { ...next, text: next.text.slice(0, typed) }];
  }, [read, lines, next, typed]);
  const typing = !!next;

  /* Entering a step the AI has not spoken in yet starts it */
  useEffect(() => {
    if (!su || !ai || choose || busy || su.step === "fertig") return;
    const key = `${su.id}:${su.step}`;
    if (started === key || su.chat.some(m => m.step === su.step && m.role === "ai")) return;
    setStarted(key); post({ action: "start" });
  }, [su, ai, choose, busy, started, post]);

  const send = useCallback(async (msg: string) => {
    if (!msg.trim()) return;
    setSu(s => s && { ...s, chat: [...s.chat, { role: "me", text: msg, step: s.step }] });
    await post({ action: "message", text: msg });
  }, [post]);

  async function pick(label: string) {
    if (label === NEW_KEY) { setChoose(null); setAi(false); return; }
    const o = choose?.find(x => x.label === label);
    if (!o) return;
    try { await api(`/api/tenants/${t.slug}`, { method: "PATCH", body: { settings: { ai: o.id } } }); setChoose(null); ctx.reload(); }
    catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }

  /* Without any model nothing works, so the key is the first answer in the chat */
  async function connect(raw: string) {
    const key = raw.trim(), kind = key.startsWith("sk-ant-") ? "claude" : "openrouter";
    if (!key) return;
    setLocal(l => [...l, { id: `me${l.length}`, role: "me", text: `${key.slice(0, 6)}…${key.slice(-4)}` }]);
    setBusy(true);
    try {
      await api("/api/integrations", { body: { t: t.slug, kind, values: kind === "openrouter" ? { key, model: OPENROUTER_MODELS[0][0] } : { key } } });
      await api(`/api/tenants/${t.slug}`, { method: "PATCH", body: { settings: { ai: kind === "openrouter" ? `openrouter:${OPENROUTER_MODELS[0][0]}` : "claude" } } });
      ctx.reload(); await load();
    }
    catch (e) { setLocal(l => [...l, { id: `ai${l.length}`, role: "ai", text: `Das hat nicht geklappt: ${(e as Error).message}. Prüfe den Schlüssel und füge ihn noch einmal ein.` }]); }
    finally { setBusy(false); }
  }

  async function finish() {
    if (!su) return;
    setBusy(true);
    try {
      const r = await api<{ applied: { prompt: boolean; templates: number; leads: number } }>("/api/setup", { body: { t: t.slug, action: "apply", prompt: su.segments.length ? res?.parts.fertig ?? "" : "", templates: su.templates.length > 0, leads: good > 0 } });
      const a = r.applied;
      ctx.toast([a.prompt && "Zielgruppe", a.templates && `${a.templates} Vorlagen`, a.leads && `${a.leads} Leads`].filter(Boolean).join(", ") + " übernommen");
      await ctx.reload(); ctx.setView(a.leads ? "leads" : "einstellungen");
    } catch (e) { ctx.toast((e as Error).message, { error: true }); }
    setBusy(false);
  }

  const goto = (k: SetupStep) => { setRail(false); if (su && k !== su.step) post({ action: "goto", step: k }); };

  const runtime = useExternalStoreRuntime({
    messages: shown, convertMessage: convert, isRunning: busy || typing, isDisabled: su?.step === "fertig",
    onNew: async (m: AppendMessage) => { const p = m.content.find(c => c.type === "text"); if (p?.type !== "text") return; if (choose) await pick(p.text); else if (ai) await send(p.text); else await connect(p.text); },
  });

  const top = <Top title="Einrichtung" onMenu={ctx.openSidebar}>
    <button className="btn gh ic cl-mob" onClick={() => setRail(true)} aria-label="Schritte anzeigen"><Icon n="menu" /></button>
  </Top>;
  if (!su) return <>{top}<div className="cl"><main className="cl-main" /></div></>;

  const last = shown.at(-1), quiet = !busy && !typing;

  return <>
    {top}
  <div className={`cl ${rail ? "rail" : ""}`}>
    <nav className="cl-rail"><Steps su={su} busy={busy} open={k => { setRail(false); setOpen(k); }} /></nav>
    {rail && <div className="cl-scrim" onClick={() => setRail(false)} />}

    <main className="cl-main">
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root className="cl-thread">
          <ThreadPrimitive.Viewport className="cl-vp">
            <ThreadPrimitive.Messages>{() => <Msg />}</ThreadPrimitive.Messages>
            {busy && !typing && <div className="cl-col cl-run"><Spark spin />{ai ? BUSY[su.step] : "Prüfe den Schlüssel"}{ai && su.step === "website" ? ` ${t.domain}` : ""}</div>}
            {quiet && ai && su.step === "liste" && su.leads.length > 0 && <div className="cl-col cl-inl"><LeadList su={su} busy={busy} post={post} send={send} /></div>}
            {quiet && ai && su.step === "ansprache" && su.templates.length > 0 && <div className="cl-col cl-inl"><Mails xs={su.templates} /></div>}
            <ThreadPrimitive.ViewportFooter className="cl-foot">
              {quiet && last?.role === "ai" && last.chips?.length ? <div className="cl-chips">{last.chips.map(c => <button key={c} onClick={() => last.id === "pick" ? pick(c) : su.step === "fertig" ? finish() : send(c)}>{c}</button>)}</div> : null}
              <ComposerPrimitive.Root className="cl-comp">
                <ComposerPrimitive.Input rows={1} autoFocus placeholder={ai ? "Antworten" : "API-Schlüssel einfügen"} aria-label="Antwort" className="cl-in" />
                <div className="cl-cbar"><span className="sp" /><ComposerPrimitive.Send className="cl-send" aria-label="Senden"><Icon n="arrow-up" /></ComposerPrimitive.Send></div>
              </ComposerPrimitive.Root>
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </main>
  </div>
  {open && res && <PromptDialog key={open} step={open} text={res.parts[open]} label={res.keys[open]} busy={busy} onClose={() => setOpen(null)}
    onGo={() => { setOpen(null); goto(open); }} onSave={async text => {
      try { apply(await api<Res>("/api/setup", { body: { t: t.slug, action: "prompt", step: open, text } })); setOpen(null); } catch (e) { ctx.toast((e as Error).message, { error: true }); }
    }} />}
  </>;
}

/* What a step contributes to the evening research: the key line as keywords on top, the whole section below. Both edit the same text */
function PromptDialog({ step, text, label, busy, onClose, onGo, onSave }: {
  step: SetupStep; text: string; label?: string; busy: boolean; onClose: () => void; onGo: () => void; onSave: (t: string) => Promise<void>;
}) {
  const [v, setV] = useState(text), [saving, setSaving] = useState(false);
  const re = label ? new RegExp(`^${label}:[ \\t]*(.*)$`, "m") : null;
  const keys = re ? v.match(re)?.[1] ?? "" : "";
  const setKeys = (k: string) => setV(re!.test(v) ? v.replace(re!, () => `${label}: ${k}`) : `${label}: ${k}\n${v}`);
  const ref = useDialog(onClose);
  return <div className="ov" onClick={e => e.target === e.currentTarget && onClose()}><div className="dlg lg" ref={ref} role="dialog" aria-modal="true" aria-label={NAME[step]}>
    <div className="dlg-h">{NAME[step]}<button className="btn gh ic" onClick={onClose} aria-label="Schließen"><Icon n="x" /></button></div>
    {label && <label className="fld"><span>{label}</span><textarea className="inp ta keys" rows={2} value={keys} onChange={e => setKeys(e.target.value.replace(/\s*\n\s*/g, " "))} /></label>}
    <label className="fld"><span>Prompt</span><textarea className="prompt" value={v} onChange={e => setV(e.target.value)} /></label>
    <div className="dlg-f">
      {step !== "fertig" && <button className="btn sec" onClick={onGo} disabled={busy}>Zu diesem Schritt</button>}
      <span className="sp" />
      <button className="btn gh" onClick={onClose}>Abbrechen</button>
      <button className="btn pri" onClick={async () => { setSaving(true); await onSave(v); setSaving(false); }} disabled={saving || v === text}>{saving && <Icon n="loader" />}Speichern</button>
    </div>
  </div></div>;
}

const Link = (p: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...p} target="_blank" rel="noreferrer" />;

/* claude.ai: user turns in a bubble on the right, assistant turns as plain serif text with a copy action on hover */
function Msg() {
  const role = useAuiState(s => s.message.role);
  if (role === "user") return <MessagePrimitive.Root className="cl-col cl-me"><div><MessagePrimitive.Parts>{({ part }) => part.type === "text" ? <MarkdownTextPrimitive className="cl-md" /> : null}</MessagePrimitive.Parts></div></MessagePrimitive.Root>;
  return <MessagePrimitive.Root className="cl-col cl-ai">
    <MessagePrimitive.Parts>{({ part }) => part.type === "text" ? <MarkdownTextPrimitive className="cl-md" components={{ a: Link }} /> : null}</MessagePrimitive.Parts>
    <ActionBarPrimitive.Root className="cl-acts"><ActionBarPrimitive.Copy className="cl-ib" aria-label="Kopieren"><Icon n="copy" /></ActionBarPrimitive.Copy></ActionBarPrimitive.Root>
  </MessagePrimitive.Root>;
}

function Spark({ spin }: { spin?: boolean }) {
  return <svg className={`cl-spark ${spin ? "spin" : ""}`} viewBox="0 0 24 24" aria-hidden="true">
    {[0, 30, 60, 90, 120, 150].map(a => <rect key={a} x="11" y="2" width="2" height="20" rx="1" transform={`rotate(${a} 12 12)`} />)}
  </svg>;
}

function Steps({ su, busy, open }: { su: Setup; busy: boolean; open: (k: SetupStep) => void }) {
  const idx = STEPS.findIndex(([k]) => k === su.step);
  return <div className="cl-rs">{STEPS.map(([k, n], i) => {
    const cur = k === su.step, skipped = su.skipped.includes(k);
    return <div key={k} className={`cl-sec ${cur ? "on" : ""}`}>
      <button className="cl-sh" onClick={() => open(k)} disabled={busy} aria-current={cur ? "step" : undefined}>
        {cur ? <i className="cl-dot" /> : i < idx && !skipped ? <Icon n="check" /> : <i className="cl-dot off" />}{n}{skipped && <span className="cl-skip">übersprungen</span>}
      </button>
    </div>;
  })}</div>;
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
        <b className="cl-co">{httpUrl(r.website) ? <a href={httpUrl(r.website)} target="_blank" rel="noreferrer">{r.company}</a> : r.company}</b>
        <div className="cl-vote">
          <button className={`btn gh ic ${r.vote === 1 ? "up" : ""}`} aria-label="Passt" aria-pressed={r.vote === 1} onClick={() => vote(i, 1)}><Icon n="thumbs-up" /></button>
          <button className={`btn gh ic ${r.vote === -1 ? "down" : ""}`} aria-label="Passt nicht" aria-pressed={r.vote === -1} onClick={() => vote(i, -1)}><Icon n="thumbs-down" /></button>
        </div>
      </div>
      <div className="f2">{r.person ? <>{httpUrl(r.linkedin) ? <a href={httpUrl(r.linkedin)} target="_blank" rel="noreferrer">{r.person}</a> : r.person}{r.role && `, ${r.role}`}</> : "Kein Ansprechpartner"}{r.segment && ` · ${r.segment}`}</div>
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
