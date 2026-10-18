"use client";
import { useCallback, useEffect, useRef } from "react";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, Building2, Check, CheckCheck, CircleAlert, ChevronDown, ChevronUp, ChevronsUpDown, Copy, Database, Dot, Download, ExternalLink, FileCheck2, FileText, Globe, GripVertical,
  Inbox, KeyRound, Landmark, LayoutDashboard, LoaderCircle, LogOut, Mail, Menu, Plus, ReceiptText, Search, Send, Server, Settings2, Sparkles, Square, SunMoon,
  Target, ThumbsDown, ThumbsUp, Trash2, TriangleAlert, Undo2, Upload, User, UserPlus, Users, Workflow, X, type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  "arrow-down": ArrowDown, "arrow-left": ArrowLeft, "arrow-right": ArrowRight, "arrow-up": ArrowUp, bell: Bell, "building-2": Building2, check: Check, "check-check": CheckCheck, "circle-alert": CircleAlert, "chevron-down": ChevronDown,
  "chevron-up": ChevronUp, "chevrons-up-down": ChevronsUpDown, copy: Copy, database: Database, dot: Dot, download: Download, "external-link": ExternalLink, "file-check-2": FileCheck2, "file-text": FileText,
  globe: Globe, "grip-vertical": GripVertical, inbox: Inbox, "key-round": KeyRound, landmark: Landmark, "layout-dashboard": LayoutDashboard, loader: LoaderCircle, "log-out": LogOut, mail: Mail,
  menu: Menu, plus: Plus, "receipt-text": ReceiptText, search: Search, send: Send, server: Server, "settings-2": Settings2, sparkles: Sparkles, square: Square, "sun-moon": SunMoon,
  target: Target, "thumbs-down": ThumbsDown, "thumbs-up": ThumbsUp, "trash-2": Trash2, "triangle-alert": TriangleAlert, "undo-2": Undo2, upload: Upload, user: User, "user-plus": UserPlus, users: Users, workflow: Workflow, x: X,
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
