"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, Building2, Calendar, Check, CheckCheck, CircleAlert, ChevronDown, ChevronUp, ChevronsUpDown, Copy, Database, Dot, Download, ExternalLink, FileCheck2, FileText, Globe, GripVertical,
  Inbox, KeyRound, Landmark, LayoutDashboard, ListTodo, LoaderCircle, LogOut, Mail, Menu, Phone, Plus, Presentation, ReceiptText, Search, Send, Server, Settings2, Sparkles, Square, StickyNote, SunMoon,
  Target, ThumbsDown, ThumbsUp, Trash2, TriangleAlert, Undo2, Upload, User, UserCheck, UserPlus, Users, Workflow, X, type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  "arrow-down": ArrowDown, "arrow-left": ArrowLeft, "arrow-right": ArrowRight, "arrow-up": ArrowUp, bell: Bell, "building-2": Building2, calendar: Calendar, check: Check, "check-check": CheckCheck, "circle-alert": CircleAlert, "chevron-down": ChevronDown,
  "chevron-up": ChevronUp, "chevrons-up-down": ChevronsUpDown, copy: Copy, database: Database, dot: Dot, download: Download, "external-link": ExternalLink, "file-check-2": FileCheck2, "file-text": FileText,
  globe: Globe, "grip-vertical": GripVertical, inbox: Inbox, "key-round": KeyRound, landmark: Landmark, "layout-dashboard": LayoutDashboard, "list-todo": ListTodo, loader: LoaderCircle, "log-out": LogOut, mail: Mail,
  menu: Menu, phone: Phone, plus: Plus, presentation: Presentation, "receipt-text": ReceiptText, search: Search, send: Send, server: Server, "settings-2": Settings2, sparkles: Sparkles, square: Square, "sticky-note": StickyNote, "sun-moon": SunMoon,
  target: Target, "thumbs-down": ThumbsDown, "thumbs-up": ThumbsUp, "trash-2": Trash2, "triangle-alert": TriangleAlert, "undo-2": Undo2, upload: Upload, user: User, "user-check": UserCheck, "user-plus": UserPlus, users: Users, workflow: Workflow, x: X,
};

export function Icon({ n, className }: { n: string; className?: string }) {
  if (n === "linkedin") return (
    <svg className={`lucide ${className || ""}`} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" /><rect width="4" height="12" x="2" y="9" /><circle cx="4" cy="4" r="2" />
    </svg>);
  const C = ICONS[n];
  if (!C) return null;
  return <C className={`${n === "loader" ? "spin " : ""}${className || ""}`} aria-hidden="true" />;
}

export async function api<T = unknown>(url: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const r = await fetch(url, { signal: init?.signal, method: init?.method || (init?.body ? "POST" : "GET"), headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined });
  if (r.status === 401) { location.href = "/login"; throw new Error("Nicht angemeldet"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Fehler ${r.status}`);
  return j as T;
}

/* Escape closes a dialog */
export function useEscape(close: () => void) {
  const c = useRef(close);
  useEffect(() => { c.current = close; });
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") c.current(); };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, []);
}

/* Dialog ref: focus moves in and stays inside, Escape closes, focus goes back to where it was */
const FOCUSABLE = "a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";
let outside: HTMLElement | null = null;
if (typeof document !== "undefined") document.addEventListener("focusin", e => { if (!(e.target as HTMLElement).closest?.("[role=dialog]")) outside = e.target as HTMLElement; });
export function useDialog(close: () => void) {
  const c = useRef(close);
  useEffect(() => { c.current = close; });
  return useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const a = document.activeElement as HTMLElement | null, prev = a && !a.closest("[role=dialog]") && a !== document.body ? a : outside;
    const items = () => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(x => x.getClientRects().length);
    /* after autoFocus inside has had its turn */
    queueMicrotask(() => { if (!el.contains(document.activeElement)) { const f = items(); (f.find(x => !x.closest(".dlg-h")) ?? f[0])?.focus(); } });
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") { c.current(); return; }
      if (e.key !== "Tab") return;
      const f = items(), i = f.indexOf(document.activeElement as HTMLElement);
      if (!f.length) e.preventDefault();
      else if (i < 0 || (e.shiftKey ? i === 0 : i === f.length - 1)) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
    };
    addEventListener("keydown", k);
    return () => { removeEventListener("keydown", k); if (prev?.isConnected) prev.focus(); };
  }, []);
}

export const pct =(n: number) => (isFinite(n) ? n : 0).toFixed(1).replace(".", ",") + " %";
export const rate = (t: { sent: number; replies: number }) => t.sent ? t.replies / t.sent * 100 : 0;
export const hue = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
export const ini = (s: string) => s.replace(/&/g, "").split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join("").toUpperCase();
export function Av({ s }: { s: string }) { return <span className="av" style={{ ["--h" as string]: hue(s) }}>{ini(s)}</span>; }

export function useAutosize() {
  return (ta: HTMLTextAreaElement | null) => { if (!ta) return; ta.style.height = "auto"; ta.style.height = Math.max(280, ta.scrollHeight) + "px"; };
}

export function Top({ title, onMenu, children }: { title: string; onMenu: () => void; children?: React.ReactNode }) {
  return <div className="top"><button className="btn gh ic mob" onClick={e => { e.stopPropagation(); onMenu(); }} aria-label="Menü"><Icon n="menu" /></button><h1>{title}</h1><span className="sp" />{children}</div>;
}

/* a choice as a button: the whole button opens it, the list always drops below; options are [value, label] */
export function Select({ value, onChange, options, label, className, disabled }: { value: string; onChange: (v: string) => void; options: [string, React.ReactNode][]; label: string; className?: string; disabled?: boolean }) {
  const [at, setAt] = useState<{ top: number; left: number; width: number; max: number; room: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null);
  const shut = (focus = true) => { setAt(null); if (focus) btn.current?.focus(); };
  const open = () => { const r = btn.current!.getBoundingClientRect(); setAt({ top: r.bottom + 4, left: r.left, width: r.width, max: Math.max(120, innerHeight - r.bottom - 12), room: innerWidth - r.left - 8 }); };
  const isOpen = !!at;
  useEffect(() => {
    if (!isOpen) return;
    const el = list.current!;
    (el.querySelector<HTMLElement>("[aria-selected=true]") ?? el.querySelector<HTMLElement>("button"))?.focus();
    const off = (e: Event) => { if (!el.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) shut(false); };
    const away = (e: Event) => { if (!el.contains(e.target as Node)) shut(false); };
    document.addEventListener("mousedown", off); addEventListener("scroll", away, true); addEventListener("resize", away);
    return () => { document.removeEventListener("mousedown", off); removeEventListener("scroll", away, true); removeEventListener("resize", away); };
  }, [isOpen]);
  const keys = (e: React.KeyboardEvent) => {
    const f = [...list.current!.querySelectorAll<HTMLElement>("button")], i = f.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); shut(); }
    else if (e.key === "Tab") shut(false);
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); f[Math.min(f.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus(); }
    else if (e.key === "Home" || e.key === "End") { e.preventDefault(); f[e.key === "Home" ? 0 : f.length - 1]?.focus(); }
  };
  const cur = options.find(([v]) => v === value)?.[1] ?? "";
  return <>
    <button ref={btn} type="button" className={className} disabled={disabled} aria-label={label} aria-haspopup="listbox" aria-expanded={isOpen}
      onClick={() => isOpen ? shut() : open()} onKeyDown={e => { if (!isOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); open(); } }}>
      <span className="sv">{cur}</span><Icon n="chevron-down" /></button>
    {at && createPortal(<div ref={list} className="pop sel-pop" role="listbox" aria-label={label} onKeyDown={keys}
      style={{ top: at.top, left: at.left, minWidth: at.width, maxHeight: at.max, maxWidth: at.room }}>
      {options.map(([v, l]) => <button key={v} type="button" role="option" aria-selected={v === value} onClick={() => { onChange(v); shut(); }}>{l}{v === value && <Icon n="check" className="end" />}</button>)}
    </div>, document.body)}
  </>;
}
