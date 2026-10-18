"use client";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { Icon, api } from "./ui";
import type { Ctx } from "./types";

type Msg = { role: "user" | "assistant"; content: string };
const store = {
  get: (k: string): Msg[] => { try { const v = JSON.parse(sessionStorage.getItem(k) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } },
  set: (k: string, v: Msg[]) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

/* Docked at the bottom of the lead list: talk to the AI about the list, it reorders and edits leads; onChanged reloads the list */
export function LeadChat({ slug, onChanged, toast }: { slug: string; onChanged: () => void; toast: Ctx["toast"] }) {
  const key = `lead-chat-${slug}`;
  const [msgs, setMsgs] = useState<Msg[]>([]), [text, setText] = useState(""), [busy, setBusy] = useState(false), [open, setOpen] = useState(false);
  const log = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null), stop = useRef<AbortController | null>(null);
  useEffect(() => { setMsgs(store.get(key)); }, [key]);
  useEffect(() => { const el = log.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs, open, busy]);
  /* the field grows with its text up to a few lines */
  useEffect(() => { const el = input.current; if (el) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 160)}px`; } }, [text]);

  const put = (m: Msg[]) => { setMsgs(m); store.set(key, m); };
  async function send() {
    const q = text.trim();
    if (!q || busy) return;
    const next = [...msgs, { role: "user" as const, content: q }];
    put(next); setText(""); setOpen(true); setBusy(true);
    const ac = new AbortController(); stop.current = ac;
    try {
      const r = await api<{ reply: string; changed: number }>("/api/leads/chat", { body: { t: slug, messages: next }, signal: ac.signal });
      put([...next, { role: "assistant", content: r.reply }]);
      if (r.changed) onChanged();
    } catch (e) {
      if (!ac.signal.aborted) toast((e as Error).message, { error: true });
      put(msgs); setText(q);
    } finally { setBusy(false); stop.current = null; }
  }

  return <div className={`lc${open && msgs.length ? " open" : ""}`} onKeyDown={e => { if (e.key === "Escape") setOpen(false); }}>
    {open && msgs.length > 0 && <div className="lc-log" ref={log} role="log" aria-label="KI-Chat">
      <div className="lc-bar">
        <button className="btn gh ic" title="Neues Gespräch" aria-label="Neues Gespräch" onClick={() => { put([]); setOpen(false); }} disabled={busy}><Icon n="trash-2" /></button>
        <button className="btn gh ic" title="Einklappen" aria-label="Einklappen" onClick={() => setOpen(false)}><Icon n="chevron-down" /></button>
      </div>
      {msgs.map((m, i) => m.role === "user"
        ? <div key={i} className="lc-me"><div>{m.content}</div></div>
        : <div key={i} className="lc-ai cl-md"><Markdown>{m.content}</Markdown></div>)}
      {busy && <div className="lc-ai f3"><Icon n="loader" /></div>}
    </div>}
    <div className="lc-comp">
      <textarea ref={input} rows={1} className="lc-in" value={text} placeholder="Lead-Liste ändern oder fragen" aria-label="Nachricht an die KI"
        onChange={e => setText(e.target.value)} onFocus={() => msgs.length && setOpen(true)}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
      {busy ? <button className="lc-send" aria-label="Stoppen" onClick={() => stop.current?.abort()}><Icon n="square" /></button>
        : <button className="lc-send" aria-label="Senden" onClick={send} disabled={!text.trim()}><Icon n="arrow-up" /></button>}
    </div>
  </div>;
}
