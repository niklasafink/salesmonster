"use client";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { Icon } from "./ui";
import type { Ctx } from "./types";

type Msg = { role: "user" | "assistant"; content: string };
export type ChatChange = { ids: number[]; reordered: boolean };
const store = {
  get: (k: string): Msg[] => { try { const v = JSON.parse(sessionStorage.getItem(k) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } },
  set: (k: string, v: Msg[]) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

type Done = { reply: string; changed: number; ids?: number[]; reordered?: boolean };

/* POST answered as NDJSON: onReply gets the answer so far while it streams, the last line carries the result */
async function ask(body: unknown, signal: AbortSignal, onReply: (reply: string) => void): Promise<Done> {
  const r = await fetch("/api/leads/chat", { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (r.status === 401) { location.href = "/login"; throw new Error("Nicht angemeldet"); }
  if (!r.headers.get("content-type")?.includes("ndjson") || !r.body) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `Fehler ${r.status}`);
  }
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    const ls = buf.split("\n"); buf = ls.pop() ?? "";
    for (const l of ls) {
      if (!l) continue;
      const j = JSON.parse(l) as { reply?: string; done?: Done; error?: string };
      if (j.error) throw new Error(j.error);
      if (j.done) return j.done;
      if (typeof j.reply === "string") onReply(j.reply);
    }
  }
  throw new Error("Verbindung abgebrochen, bitte noch einmal senden");
}

/* Docked at the bottom of the lead list: talk to the AI about the list, it reorders and edits leads; onChanged reloads the list */
export function LeadChat({ slug, onChanged, toast }: { slug: string; onChanged: (c: ChatChange) => void; toast: Ctx["toast"] }) {
  const key = `lead-chat-${slug}`;
  const [msgs, setMsgs] = useState<Msg[]>([]), [text, setText] = useState(""), [busy, setBusy] = useState(false), [open, setOpen] = useState(false), [live, setLive] = useState("");
  const log = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null), stop = useRef<AbortController | null>(null);
  useEffect(() => { setMsgs(store.get(key)); }, [key]);
  useEffect(() => { const el = log.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs, open, busy, live]);
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
      const r = await ask({ t: slug, messages: next.slice(-12) }, ac.signal, setLive);
      put([...next, { role: "assistant", content: r.reply }]);
      if (r.changed) onChanged({ ids: r.ids ?? [], reordered: !!r.reordered });
    } catch (e) {
      if (!ac.signal.aborted) toast((e as Error).message, { error: true });
      put(msgs); setText(q);
      /* the server may have saved part of it before the error or the stop, so the list is read again */
      onChanged({ ids: [], reordered: false });
    } finally { setBusy(false); setLive(""); stop.current = null; }
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
      {busy && (live ? <div className="lc-ai cl-md"><Markdown>{live}</Markdown></div> : <div className="lc-ai f3"><Icon n="loader" /></div>)}
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
