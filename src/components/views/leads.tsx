"use client";
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { functionalUpdate, getCoreRowModel, useReactTable, type VisibilityState } from "@tanstack/react-table";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { EnrichField, RatingInfo, Tender, Touch } from "@/db/schema";
import { Icon, Select, Top, api, useDialog } from "../ui";
import { hasField, httpUrl } from "@/lib/lead-fields";
import { EnrichReport, type EnrichDone } from "../enrich-report";
/* a background enrich run as /api/leads/enrich/jobs reports it */
type EnrichJob = { id: number; status: string; error: string; total: number; done: number; found: number; skipped: number; results: EnrichDone[] };
import { ENRICH, LeadDialog, RatingBar, STATUS, TOUCHES, emptyLead, prefetchLead, type EditLead } from "../lead-dialog";
import { AnglesDialog } from "../angles-dialog";
import { LeadChat, type ChatChange } from "../lead-chat";
import type { Ctx } from "../types";
import { FIELDS, clean, splitTable, type Column, type Field } from "@/lib/lead-columns";
import { mdTable, parseCsv, toCsv, toTsv } from "@/lib/sheet";
import { addDaysIso, berlinDate } from "@/lib/dates";
import { DAY_NAMES, isoWeekday } from "@/lib/schedule";
import { KIND_LABEL, inKind, kindOf, kindOfAll, type Kind, type KindFilter } from "@/lib/lead-kind";

type Lead = EditLead & { id: number; companyId: number | null; source: string; tenders: Tender[]; lastContactAt: string | null; createdAt: string; rating: number | null; ratingInfo: RatingInfo | null; vote: number; enrichMiss: Partial<Record<EnrichField, string>>;
  channelRec: { ch: "mail" | "linkedin" | "none"; text: string }; sendpilotAt: string | null; prospect: boolean; crmAt: string | null; stage: string; hsContactId: string; touch: Touch | null };
type Sheet = { sheet: string; data: unknown[][] };
type Company = { id: number; name: string; mode: string; email: string; hubspotId: string; domain: string };
type Campaign = { id: string; name: string; status: string; totalLeads: number };
type Parsed = { co: string; sal?: string; p: string; role: string; email: string; phone?: string; web: string; city: string; note?: string; dup: string; extra: string };
/* rows drawn at first, and added per step while scrolling */
const PAGE = 50;
const FILTERS = ["alle", "neu", "freigabe", "angeschrieben", "beantwortet", "unzustellbar", "dublette", "kontakt", "papierkorb"];

/* someone only in the CRM comes with the shown columns; the rest are the values a lead without them has */
const CRM_DEFAULTS: Omit<Lead, "id" | "company" | "createdAt"> = { companyId: null, salutation: "", first: "", last: "", role: "", email: "", emailType: "person", phone: "", linkedin: "", website: "", city: "",
  hook: "", note: "", sourceUrl: "", status: "kontakt", tenders: [], source: "HubSpot", lastContactAt: null, rating: null, ratingInfo: null, vote: 0, enrichMiss: {}, channel: "",
  channelRec: { ch: "none", text: "Registriert, wird nicht kalt angeschrieben" }, sendpilotAt: null, prospect: false, crmAt: null, stage: "", hsContactId: "", touch: null };

/* the kind filter (leads, CRM, both) and whether the list shows people or companies; both stay per browser */
const KINDS: [KindFilter, string][] = [["alle", "Leads + CRM"], ["lead", "Leads"], ["crm", "CRM"]];
const LEVELS: [string, string][] = [["person", "Personen"], ["firma", "Firmen"]];
const KindTag = ({ k }: { k: Kind }) => <span className={`pill ${k === "lead" ? "b" : k === "crm" ? "g" : "a"}`}>{KIND_LABEL[k]}</span>;

/* Filters on the rating: grade, kind of company (from the tenant's rubric), and individual contact; "none" = no demo, call or personal mail.
   Several contact kinds show who had any of them. All stay per browser. */
const GRADES: [string, string][] = [["alle", "Alle Noten"], ["A", "Note A"], ["B", "Note B"], ["C", "Note C"], ["D", "Note D"], ["ohne", "Ohne Note"]];
type TouchKey = "demo" | "call" | "mail" | "none";
const TOUCH_OPTS: [TouchKey, string, string][] = [...TOUCHES.map(([k, l, ic]) => [k, l, ic] as [TouchKey, string, string]), ["none", "Kein Kontakt", "x"]];
const touched = (t: Touch | null, k: TouchKey) => k === "none" ? !t || !(t.demo || t.call || t.mail) : !!t?.[k];

/* the contact filter in the header of its column: an icon that opens a list to tick; the list sits on the page, as the header cuts off what overflows */
function TouchFilter({ value, onChange }: { value: TouchKey[]; onChange: (v: TouchKey[]) => void }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null), btn = useRef<HTMLButtonElement>(null), pop = useRef<HTMLDivElement>(null);
  const isOpen = !!at;
  const place = () => { const r = btn.current!.getBoundingClientRect(); return { top: r.bottom + 4, left: Math.max(8, Math.min(r.left, innerWidth - 218)) }; };
  useEffect(() => {
    if (!isOpen) return;
    const off = (e: MouseEvent) => { if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setAt(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setAt(null); btn.current?.focus(); } };
    /* the list follows its button when the table scrolls, e.g. sideways to bring the button into view */
    const away = (e: Event) => { if (!pop.current?.contains(e.target as Node)) setAt(place()); };
    document.addEventListener("mousedown", off); document.addEventListener("keydown", esc); addEventListener("scroll", away, true); addEventListener("resize", away);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc); removeEventListener("scroll", away, true); removeEventListener("resize", away); };
  }, [isOpen]);
  const label = value.length ? TOUCH_OPTS.filter(([k]) => value.includes(k)).map(([, l]) => l).join(", ") : "Jeder Kontakt";
  return <>
    <button ref={btn} type="button" className={`thf${value.length ? " on" : ""}`} onClick={() => setAt(isOpen ? null : place())} aria-expanded={isOpen} aria-label={`Kontakt filtern: ${label}`} title={label}><Icon n="list-filter" /></button>
    {at && createPortal(<div ref={pop} className="pop tf-pop" role="dialog" aria-label="Kontakt" style={{ top: at.top, left: at.left }}>
      {TOUCH_OPTS.map(([k, l, ic]) => <label key={k} className="ck"><input type="checkbox" checked={value.includes(k)}
        onChange={() => onChange(value.includes(k) ? value.filter(x => x !== k) : [...value, k])} /><Icon n={ic} />{l}</label>)}
      <button className="btn sec wide" onClick={() => { onChange([]); setAt(null); }} disabled={!value.length}>Alle zeigen</button>
    </div>, document.body)}
  </>;
}

/* A column of the people list. Fixed ones (selection, drag handle, actions) keep their place; the others can be hidden and moved under "Spalten".
   head replaces the label in the header, filter sits next to it, size lets the header edge be dragged. */
type Col = { id: string; label: string; head?: ReactNode; aria?: string; fixed?: boolean; size?: boolean; filter?: ReactNode; td: (r: Lead, handle: ReactNode) => ReactNode };
/* columns that only show when switched on */
const COLS_OFF: VisibilityState = { "c-type": false, "c-city": false, "c-new": false };
/* saved choice per browser; the version goes up when the default changes, so the new default reaches everyone */
const COLS_KEY = "leads-cols-2";

function ColItem({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  return <div ref={setNodeRef} className={`colp-i${isDragging ? " drag" : ""}`} style={{ transform: CSS.Translate.toString(transform), transition }}>
    <button type="button" className="btn gh ic grip" ref={setActivatorNodeRef} {...attributes} {...listeners} aria-label="Verschieben"><Icon n="grip-vertical" /></button>{children}</div>;
}

/* "Spalten": tick the columns to show, drag them into order; the choice stays per browser */
function ColPicker({ cols, onToggle, onMove, onReset }: { cols: { id: string; label: string; on: boolean }[]; onToggle: (id: string) => void; onMove: (ids: string[]) => void; onReset: () => void }) {
  const [open, setOpen] = useState(false), ref = useRef<HTMLSpanElement>(null);
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !(e.target as HTMLElement).closest?.(".grip")) setOpen(false); };
    document.addEventListener("mousedown", off); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc); };
  }, [open]);
  const ids = cols.map(c => c.id);
  const moved = (e: DragEndEvent) => { const from = ids.indexOf(String(e.active.id)), to = e.over ? ids.indexOf(String(e.over.id)) : -1; if (from >= 0 && to >= 0 && from !== to) onMove(arrayMove(ids, from, to)); };
  const off = cols.filter(c => !c.on).length;
  return <span className="tf-at" ref={ref}>
    <button className="btn sec" onClick={() => setOpen(!open)} aria-expanded={open}><Icon n="columns-3" /><span className="hide-m">Spalten</span>{off > 0 && <span className="num f3">{cols.length - off}/{cols.length}</span>}</button>
    {open && <div className="pop colp" role="dialog" aria-label="Spalten">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={moved}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {cols.map(c => <ColItem key={c.id} id={c.id}><label className="ck"><input type="checkbox" checked={c.on} onChange={() => onToggle(c.id)} />{c.label}</label></ColItem>)}
        </SortableContext>
      </DndContext>
      <button className="btn sec wide" onClick={onReset}>Standard</button>
    </div>}
  </span>;
}

/* we already had contact: a mail went out, an answer came in, or the mailbox knows them */
const warm = (r: Lead) => !!r.lastContactAt || r.source === "Postfach" || ["angeschrieben", "beantwortet", "kontakt"].includes(r.status);

/* the send queue first by default; the choice stays per browser */
const SORTS: [string, string][] = [["versand", "Versand"], ["bewertung", "Bewertung"], ["neu", "Neueste"], ["firma", "Firma A–Z"], ["status", "Status"]];
const ORDER = Object.keys(STATUS);
const sorters: Record<string, (a: Lead, b: Lead) => number> = {
  versand: () => 0,
  bewertung: (a, b) => (b.rating ?? -1) - (a.rating ?? -1) || b.createdAt.localeCompare(a.createdAt),
  neu: (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id,
  firma: (a, b) => a.company.localeCompare(b.company, "de") || a.id - b.id,
  status: (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || (b.rating ?? -1) - (a.rating ?? -1),
};
const keep = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
export const reasonText = (r: { pts: number; text: string; learned?: boolean }) => `${r.pts > 0 ? "+" : "−"}${Math.abs(r.pts)} ${r.text}${r.learned ? " (gelernt)" : ""}`;

type Firm = { key: string; id: number | null; name: string; domain: string; people: Lead[]; sources: string[]; last: string | null };
/* people grouped by company, in the order the first of each comes in the list */
function firmsOf(people: Lead[], cos: Company[]): Firm[] {
  const byId = new Map(cos.map(c => [c.id, c])), out = new Map<string, Firm>();
  for (const r of people) {
    const key = r.companyId == null ? `l${r.id}` : `c${r.companyId}`;
    let f = out.get(key);
    if (!f) { const c = r.companyId == null ? undefined : byId.get(r.companyId); f = { key, id: r.companyId, name: c?.name || r.company, domain: c?.domain || "", people: [], sources: [], last: null }; out.set(key, f); }
    f.people.push(r);
    if (!f.sources.includes(r.source)) f.sources.push(r.source);
    if (!f.domain && r.website) { try { f.domain = new URL(httpUrl(r.website) || "x:").hostname.replace(/^www\./, ""); } catch { /* no domain */ } }
    const at = [r.lastContactAt, r.crmAt].filter(Boolean).sort().pop() || null;
    if (at && (!f.last || at > f.last)) f.last = at;
  }
  return [...out.values()];
}

/* the channel a lead is written on: set by hand, else as recommended */
const chOf = (r: Lead) => r.sendpilotAt ? "linkedin" : (r.channel === "mail" && r.email) || (r.channel === "linkedin" && r.linkedin) ? r.channel : r.channelRec.ch;

/* the day a lead is written to: the weekday within the coming week, with the date after that */
function dayCell(iso?: string) {
  if (!iso) return <span className="f3">–</span>;
  const today = berlinDate(), wd = DAY_NAMES[isoWeekday(iso) - 1], long = new Date(`${iso}T12:00:00Z`).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  return <span title={long}>{iso === today ? "Heute" : iso < addDaysIso(today, 7) ? wd : `${wd} ${iso.slice(8)}.${iso.slice(5, 7)}.`}</span>;
}

/* A row of the send queue, dragged by its handle so a click still opens the lead */
function QueueRow({ id, children, ...p }: { id: number; children: (handle: ReactNode) => ReactNode } & Omit<React.HTMLAttributes<HTMLTableRowElement>, "id" | "children">) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  const handle = <button type="button" className="btn gh ic grip" ref={setActivatorNodeRef} {...attributes} {...listeners} aria-label="Verschieben" onClick={e => e.stopPropagation()}><Icon n="grip-vertical" /></button>;
  return <tr ref={setNodeRef} {...p} className={`${p.className || ""}${isDragging ? " drag" : ""}`} style={{ transform: CSS.Translate.toString(transform), transition }}>{children(handle)}</tr>;
}

export const Dot = ({ s }: { s: string }) => <span className={`sd s-${STATUS[s]?.[1] || "n"}`} title={STATUS[s]?.[0] || s} />;

/* accent-insensitive search: "zoe" finds Zoë, "mueller" and "muller" find Müller */
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const umlaut = (s: string) => fold(s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss"));
export const matches = (hay: string, q: string) => { const f = fold(q.trim()); return !f || fold(hay).includes(f) || umlaut(hay).includes(f); };

export function Leads({ ctx, focus, onFocused }: { ctx: Ctx; focus?: number | null; onFocused?: () => void }) {
  const t = ctx.st.tenant!;
  const [rows, setRows] = useState<Lead[]>([]), [cos, setCos] = useState<Company[]>([]), [filter, setFilter] = useState("alle"), [src, setSrc] = useState("alle"), [q, setQ] = useState("");
  const [imp, setImp] = useState<null | { text: string; src: string; auto?: boolean; cols?: Column[] | null; rows: Parsed[] | null; busy: boolean }>(null);
  const [sheets, setSheets] = useState<{ list: Sheet[]; i: number } | null>(null), [drag, setDrag] = useState(false);
  const [edit, setEdit] = useState<EditLead | null>(null), [allCols, setAllCols] = useState(false);
  const [order, setOrder] = useState<number[]>([]), [days, setDays] = useState<Record<number, string>>({});
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [shown, setShown] = useState(PAGE), more = useRef<HTMLTableRowElement>(null), hover = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [kind, setKindS] = useState<KindFilter>("alle"), [level, setLevelS] = useState("person"), [coF, setCoF] = useState<number | null>(null);
  useEffect(() => { const k = keep.get("leads-kind"), l = keep.get("leads-level"); if (KINDS.some(([x]) => x === k)) setKindS(k as KindFilter); if (l === "firma") setLevelS(l); }, []);
  const setKind = (v: KindFilter) => { setKindS(v); keep.set("leads-kind", v); };
  const setLevel = (v: string) => { setLevelS(v); keep.set("leads-level", v); if (v === "firma") setCoF(null); };
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [sort, setSortState] = useState("versand"), [angles, setAngles] = useState(false);
  const [grade, setGradeS] = useState("alle"), [ctype, setCtypeS] = useState("alle"), [tf, setTfS] = useState<TouchKey[]>([]);
  useEffect(() => {
    const g = keep.get("leads-grade"), c = keep.get("leads-ctype");
    if (GRADES.some(([k]) => k === g)) setGradeS(g!); if (c) setCtypeS(c);
    try { const v = JSON.parse(keep.get("leads-touch") || "[]"); if (Array.isArray(v)) setTfS(v.filter((k): k is TouchKey => TOUCH_OPTS.some(([x]) => x === k))); } catch { /* none */ }
  }, []);
  const setGrade = (v: string) => { setGradeS(v); keep.set("leads-grade", v); };
  const setCtype = (v: string) => { setCtypeS(v); keep.set("leads-ctype", v); };
  const setTf = (v: TouchKey[]) => { setTfS(v); keep.set("leads-touch", JSON.stringify(v)); };
  /* which columns show and in what order; columns added later show unless they start switched off */
  const [colVis, setColVisS] = useState<VisibilityState>(COLS_OFF), [colOrder, setColOrderS] = useState<string[]>([]);
  useEffect(() => { try { const v = JSON.parse(keep.get(COLS_KEY) || "null"); if (v?.vis) setColVisS({ ...COLS_OFF, ...v.vis }); if (Array.isArray(v?.order)) setColOrderS(v.order); } catch { /* defaults */ } }, []);
  const setCols = (vis: VisibilityState, order: string[]) => { setColVisS(vis); setColOrderS(order); keep.set(COLS_KEY, JSON.stringify({ vis, order })); };
  const [li, setLi] = useState<null | { campaigns: Campaign[] | null; id: string; busy: boolean }>(null);
  const liRef = useDialog(() => setLi(null));
  const [enr, setEnr] = useState<null | { fields: EnrichField[]; again: boolean; picked: boolean }>(null), [sel, setSel] = useState<Set<number>>(new Set());
  const [job, setJob] = useState<EnrichJob | null>(null), [report, setReport] = useState<null | { done: EnrichDone[]; skipped: number; stopped: boolean }>(null), [live, setLive] = useState(false);
  const seenRes = useRef(0);
  const enrRef = useDialog(() => setEnr(null));
  useEffect(() => { const v = keep.get("leads-sort"); if (v && sorters[v]) setSortState(v); }, []);
  useEffect(() => { try { const v = JSON.parse(keep.get("leads-widths") || "null"); if (v && typeof v === "object") setWidths(v); } catch { /* defaults */ } }, []);
  /* dragging a header edge sets that column's width; a double click gives the default back */
  function resize(k: string, e: React.PointerEvent<HTMLSpanElement>) {
    e.preventDefault(); e.stopPropagation();
    const el = e.currentTarget, x0 = e.clientX, w0 = el.parentElement!.offsetWidth;
    el.setPointerCapture(e.pointerId);
    let w = w0;
    const move = (ev: PointerEvent) => { w = Math.max(56, Math.round(w0 + ev.clientX - x0)); setWidths(cur => ({ ...cur, [k]: w })); };
    const up = () => { el.removeEventListener("pointermove", move); setWidths(cur => { keep.set("leads-widths", JSON.stringify(cur)); return cur; }); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up, { once: true });
  }
  const unsize = (k: string) => setWidths(cur => { const n = { ...cur }; delete n[k]; keep.set("leads-widths", JSON.stringify(n)); return n; });
  const setSort = (v: string) => { setSortState(v); keep.set("leads-sort", v); };
  const impRef = useDialog(() => setImp(null));
  /* only the newest read is shown: an older answer that arrives late never overwrites a newer one */
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    return api<{ rows: Lead[]; crm?: Partial<Lead>[]; companies: Company[]; order: number[]; next: number[]; days: Record<number, string> }>(`/api/leads?t=${t.slug}`)
      .then(r => { if (n !== seq.current) return; setRows([...r.rows, ...(r.crm || []).map(c => ({ ...CRM_DEFAULTS, ...c }) as Lead)]); setCos(r.companies); setOrder(r.order); setDays(r.days || {}); })
      .catch(e => { if (n === seq.current) ctx.toast(e.message, { error: true }); });
  }, [t.slug, ctx]);
  useEffect(() => { load(); }, [load]);
  /* back in the tab: read again, the evening run or another tab may have changed the list */
  useEffect(() => {
    const vis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
  }, [load]);
  /* after the chat changed the list: read it again, switch to the send order when that changed, mark the changed rows for a moment
     and scroll to the first; ratings follow on the server after the answer, so the list is read once more a little later */
  const [flash, setFlash] = useState<Set<number>>(new Set());
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined), rereadTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const chatChanged = useCallback(async (c: ChatChange) => {
    await load();
    clearTimeout(rereadTimer.current);
    rereadTimer.current = setTimeout(load, 5000);
    if (!c.ids.length && !c.reordered) return;
    if (c.reordered) setSortState("versand");
    setFlash(new Set(c.ids));
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(new Set()), 4000);
    requestAnimationFrame(() => document.querySelector("table.leads tr.flash")?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }, [load]);
  useEffect(() => () => { clearTimeout(flashTimer.current); clearTimeout(rereadTimer.current); }, []);
  /* opened from the command palette */
  useEffect(() => { const r = focus != null && rows.find(x => x.id === focus); if (r) { setEdit(r); onFocused?.(); } }, [focus, rows, onFocused]);

  const srcs = [...new Set(rows.map(r => r.source))];
  /* the kinds of company the rubric found, most frequent first */
  const ctypes = [...rows.reduce((m, r) => r.ratingInfo?.type ? m.set(r.ratingInfo.type, (m.get(r.ratingInfo.type) || 0) + 1) : m, new Map<string, number>())].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  /* a kind kept from another tenant or an older list counts as none chosen */
  const ct = ctypes.includes(ctype) ? ctype : "alle";
  const rated = (r: Lead) => (grade === "alle" || (grade === "ohne" ? r.rating === null : r.ratingInfo?.grade === grade))
    && (ct === "alle" || r.ratingInfo?.type === ct) && (!tf.length || tf.some(k => touched(r.touch, k)));
  const inFilter = (r: Lead, s: string) => s === "alle" ? r.status !== "papierkorb" : r.status === s;
  /* status counts follow the kind and company chosen, so the tabs add up to what the list shows */
  const scoped = rows.filter(r => inKind(r, kind) && (coF == null || r.companyId === coF));
  const cnt = (s: string) => scoped.filter(r => inFilter(r, s)).length;
  /* people per company, to show colleagues next to the company name */
  const perCo = new Map<number, number>();
  for (const r of rows) if (r.companyId != null && r.status !== "papierkorb") perCo.set(r.companyId, (perCo.get(r.companyId) || 0) + 1);
  /* Versand: by send day, drafts waiting for approval included; within a day the queue order, where further contacts of a company
     follow its first one, as the evening run takes them; leads without a day come last by rating */
  const coId = new Map(rows.map(r => [r.id, r.companyId == null ? `l${r.id}` : `c${r.companyId}`]));
  const first = new Map<string, number>();
  order.forEach((id, i) => { const c = coId.get(id) ?? `l${id}`; if (!first.has(c)) first.set(c, i); });
  const queue = order.map((id, i) => ({ id, k: first.get(coId.get(id) ?? `l${id}`)!, i })).sort((a, b) => a.k - b.k || a.i - b.i).map(x => x.id);
  const pos = new Map(queue.map((id, i) => [id, i]));
  const byQueue = (a: Lead, b: Lead) => (days[a.id] || "9").localeCompare(days[b.id] || "9") || (pos.get(a.id) ?? Infinity) - (pos.get(b.id) ?? Infinity) || sorters.bewertung(a, b);
  const vis = scoped.filter(r => inFilter(r, filter) && (src === "alle" || r.source === src) && rated(r) && matches(`${r.company} ${r.first} ${r.last} ${r.email}`, q)).sort(sort === "versand" ? byQueue : sorters[sort]);
  /* dragging only where the whole queue is in view, so a move means the same as in the list */
  const canDrag = sort === "versand" && src === "alle" && grade === "alle" && ct === "alle" && !tf.length && !q.trim() && (filter === "alle" || filter === "neu") && kind !== "crm" && coF == null;
  /* the companies view: the people that pass the filters, one row per company, in the order of their first person */
  const firms = level === "firma" ? firmsOf(vis, cos) : [];
  const total = level === "firma" ? firms.length : vis.length;
  /* only the first rows are drawn; the rest follow as the end of the table is scrolled into view */
  const shownRows = vis.slice(0, shown);
  useEffect(() => { setShown(PAGE); }, [filter, src, q, sort, kind, level, coF, grade, ctype, tf]);
  useEffect(() => {
    const el = more.current;
    if (!el || shown >= total) return;
    const io = new IntersectionObserver(es => { if (es[0].isIntersecting) setShown(n => n + PAGE); }, { root: el.closest(".scroll"), rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [shown, total]);
  /* rows the chat changed or the palette opened may lie below what is drawn yet */
  useEffect(() => {
    const at = vis.reduce((m, r, i) => flash.has(r.id) ? i : m, -1);
    if (at >= shown) setShown(at + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash]);
  /* a line under the last lead of each send day */
  const dayEnd = new Set(sort === "versand" ? vis.filter((r, i) => days[r.id] && days[vis[i + 1]?.id] !== days[r.id]).map(r => r.id) : []);
  async function moved(e: DragEndEvent) {
    const from = queue.indexOf(Number(e.active.id)), to = e.over ? queue.indexOf(Number(e.over.id)) : -1;
    if (from < 0 || to < 0 || from === to) return;
    const nx = arrayMove(queue, from, to);
    /* the list sorts by day first: the places keep their days, so a lead moved into another day shows there before the server answers */
    setDays(d => { const n = { ...d }; queue.forEach((id, i) => { if (d[id]) n[nx[i]] = d[id]; }); return n; });
    setOrder(nx);
    /* the moved block keeps its places; what follows stays sorted by rating */
    try { await api("/api/leads/queue", { method: "PUT", body: { t: t.slug, ids: nx.slice(0, Math.max(from, to) + 1) } }); load(); }
    catch (err) { ctx.toast((err as Error).message, { error: true }); load(); }
  }

  const coOf = (r: Lead) => r.companyId ? cos.find(c => c.id === r.companyId) : undefined;
  const contactsOf = (r: Lead) => r.companyId ? rows.filter(x => x.companyId === r.companyId) : [r];

  /* the trash keeps the lead, so research and import recognise it and nobody writes to it */
  async function trash(r: Lead, back = false) {
    const status = back ? (warm({ ...r, status: "" }) || r.crmAt ? "kontakt" : "neu") : "papierkorb";
    setRows(rs => rs.map(x => x.id === r.id ? { ...x, status } : x));
    try { await api(`/api/leads/${r.id}`, { method: "PATCH", body: { status } }); ctx.toast(back ? "Wiederhergestellt" : "In den Papierkorb gelegt"); }
    catch (e) { ctx.toast((e as Error).message, { error: true }); load(); }
  }
  /* thumbs teach the rating what the user thinks; the same thumb again takes it back */
  async function vote(r: Lead, v: number) {
    const next = r.vote === v ? 0 : v;
    setRows(rs => rs.map(x => x.id === r.id ? { ...x, vote: next } : x));
    try { await api(`/api/leads/${r.id}`, { method: "PATCH", body: { vote: next } }); load(); }
    catch (e) { ctx.toast((e as Error).message, { error: true }); load(); }
  }
  /* Files become tab-separated text with header row and go straight to the column view */
  async function pick(f?: File) {
    if (!f || !imp) return;
    const ext = f.name.split(".").pop()?.toLowerCase(), name = f.name.replace(/\.\w+$/, "");
    let text;
    try {
      if (ext === "csv" || ext === "md") {
        const buf = await f.arrayBuffer();
        let txt; try { txt = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { txt = new TextDecoder("windows-1252").decode(buf); }
        /* Markdown: a pipe table goes to the column view, anything else to the parser as free text */
        const md = ext === "md" && mdTable(txt);
        text = ext === "csv" ? toTsv(parseCsv(txt)) : md ? toTsv(md) : txt.trim(); setSheets(null);
        if (!text) throw new Error("Datei ist leer");
      } else if (ext === "xlsx") {
        const { default: read } = await import("read-excel-file/browser");
        const list = await read(f).catch(() => { throw new Error("Datei nicht lesbar"); });
        text = toTsv(list[0].data); setSheets(list.length > 1 ? { list, i: 0 } : null);
      } else throw new Error("Nur .xlsx, .csv und .md");
    } catch (e) { ctx.toast((e as Error).message, { error: true }); return; }
    /* a Quelle typed meanwhile stays, one taken from an earlier file name is replaced */
    setImp(cur => cur && { ...cur, text, ...(!cur.src || cur.auto ? { src: name, auto: true } : {}) });
    analyze(text);
  }
  function pickSheet(i: number) {
    if (!sheets) return; setSheets({ ...sheets, i });
    let text;
    try { text = toTsv(sheets.list[i].data); } catch (e) { ctx.toast((e as Error).message, { error: true }); return; }
    setImp(cur => cur && { ...cur, text });
    analyze(text);
  }
  /* Tables first get a column mapping (Jev) to review; free text goes straight to the parser */
  async function analyze(text: string) {
    setImp(cur => cur && { ...cur, busy: true });
    try {
      const { cols } = await api<{ cols: Column[] | null }>("/api/leads/columns", { body: { t: t.slug, text } });
      if (cols) { setAllCols(false); setImp(cur => cur && { ...cur, cols, rows: null, busy: false }); return; }
      const r = await api<{ rows: Parsed[] }>("/api/leads/parse", { body: { t: t.slug, text } });
      setImp(cur => cur && { ...cur, cols: null, rows: r.rows, busy: false });
    } catch (e) { ctx.toast((e as Error).message, { error: true }); setImp(cur => cur && { ...cur, busy: false }); }
  }
  async function mapped() {
    if (!imp?.cols) return;
    if (!imp.cols.some(c => c.field === "co")) { ctx.toast("Ordne eine Spalte der Firma zu", { error: true }); return; }
    setImp({ ...imp, busy: true });
    try { const r = await api<{ rows: Parsed[] }>("/api/leads/parse", { body: { t: t.slug, text: imp.text, map: imp.cols.map(c => c.field) } }); setImp(cur => cur && { ...cur, rows: r.rows, busy: false }); }
    catch (e) { ctx.toast((e as Error).message, { error: true }); setImp(cur => cur && { ...cur, busy: false }); }
  }
  const setField = (i: number, field: Field) => setImp(cur => cur?.cols ? { ...cur, cols: cur.cols.map((c, k) => k === i ? { ...c, field } : c) } : cur);
  async function save() {
    if (!imp?.rows) return;
    const add = imp.rows.filter(r => !r.dup);
    try {
      const r = await api<{ n: number; filled: number }>("/api/leads", { body: { t: t.slug, rows: add, source: imp.src || "Import" } });
      ctx.toast([r.n && `${r.n} ${r.n === 1 ? "Lead" : "Leads"} übernommen`, r.filled && `${r.filled} ergänzt`].filter(Boolean).join(", ") || "Nichts Neues");
      setImp(null); setFilter(r.n ? "neu" : "alle"); load();
    }
    catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }

  /* the leads in view that have a LinkedIn profile go into a SendPilot campaign */
  const liLeads = vis.filter(r => /linkedin\.com\/in\//i.test(r.linkedin) && !r.sendpilotAt && chOf(r) === "linkedin" && !["papierkorb", "dublette"].includes(r.status));
  async function openLi() {
    setLi({ campaigns: null, id: "", busy: false });
    try { const { campaigns } = await api<{ campaigns: Campaign[] }>(`/api/sendpilot?t=${t.slug}`); setLi(cur => cur && { ...cur, campaigns, id: campaigns[0]?.id || "" }); }
    catch (e) { ctx.toast((e as Error).message, { error: true }); setLi(null); }
  }
  async function pushLi() {
    if (!li?.id) return;
    setLi({ ...li, busy: true });
    try {
      const r = await api<{ added: number; duplicates: number }>("/api/sendpilot", { body: { t: t.slug, campaignId: li.id, leadIds: liLeads.map(r => r.id) } });
      ctx.toast(`${r.added} ${r.added === 1 ? "Lead" : "Leads"} in SendPilot${r.duplicates ? `, ${r.duplicates} schon drin` : ""}`); setLi(null); load();
    } catch (e) { ctx.toast((e as Error).message, { error: true }); setLi(cur => cur && { ...cur, busy: false }); }
  }

  /* the ticked leads, or all in view, that lack a chosen field; ones a search already came back empty for only when asked again */
  const open = (r: Lead) => !["papierkorb", "dublette"].includes(r.status);
  const picked = rows.filter(r => sel.has(r.id));
  const scope = (all: boolean) => all ? vis : picked;
  const enrichable = (e: NonNullable<typeof enr>) => scope(!e.picked).filter(r => open(r) && e.fields.some(f => !hasField(r, f) && (e.again || !r.enrichMiss?.[f])));
  const missedBefore = (e: NonNullable<typeof enr>) => scope(!e.picked).filter(r => open(r) && e.fields.some(f => !hasField(r, f) && r.enrichMiss?.[f])).length;
  const openEnrich = () => {
    let fields: EnrichField[] = ["email", "phone", "linkedin"];
    try { const v = JSON.parse(keep.get("enrich-fields") || "null"); if (Array.isArray(v)) fields = ENRICH.map(([k]) => k).filter(k => v.includes(k)); } catch { /* keep default */ }
    setEnr({ fields, again: false, picked: picked.length > 0 });
  };
  const toggle = (id: number) => setSel(s => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; });
  const allOn = vis.length > 0 && vis.every(r => sel.has(r.id));
  /* the run lives on the server: switching tenants, reloading or closing the tab does not stop it, coming back shows it again */
  const poll = useCallback(async () => {
    const { job: j } = await api<{ job: EnrichJob | null }>(`/api/leads/enrich/jobs?t=${t.slug}`);
    if (!j) { setJob(null); return; }
    const fresh = j.results.slice(seenRes.current); seenRes.current = j.results.length;
    if (fresh.length) setRows(rs => rs.map(x => { const r = fresh.find(f => f.id === x.id); return r ? { ...x, ...r.found } : x; }));
    if (j.status === "laeuft") { setJob(j); return; }
    setJob(null); setLive(false); seenRes.current = 0; load();
    api("/api/leads/enrich/jobs", { method: "PATCH", body: { t: t.slug, id: j.id, action: "seen" } }).catch(() => {});
    if (j.status === "fehler") ctx.toast(j.error, { error: true });
    if (j.results.length || j.skipped) setReport({ done: j.results, skipped: j.skipped, stopped: j.status !== "fertig" });
  }, [t.slug, load, ctx]);
  useEffect(() => { poll().catch(() => {}); }, [poll]);
  const running = !!job;
  useEffect(() => { if (!running) return; const iv = setInterval(() => poll().catch(() => {}), 3000); return () => clearInterval(iv); }, [running, poll]);
  async function runEnrich() {
    if (!enr) return;
    const { fields } = enr, list = enrichable(enr), skipped = enr.again ? 0 : missedBefore(enr) - list.filter(r => fields.some(f => !hasField(r, f) && r.enrichMiss?.[f])).length;
    keep.set("enrich-fields", JSON.stringify(fields));
    setEnr(null);
    try { const { job: j } = await api<{ job: EnrichJob }>("/api/leads/enrich/jobs", { body: { t: t.slug, ids: list.map(l => l.id), fields, again: enr.again, skipped } }); seenRes.current = 0; setJob(j); }
    catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }
  async function stopEnrich() {
    if (!job) return;
    try { await api("/api/leads/enrich/jobs", { method: "PATCH", body: { t: t.slug, id: job.id, action: "stop" } }); await poll(); }
    catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }

  /* a company row opens its people */
  const openFirm = (f: Firm) => { if (f.id != null) { setCoF(f.id); setLevel("person"); } else if (f.people[0]) setEdit(f.people[0]); };
  const kindTitle = (r: Lead) => [r.prospect && `Lead, Quelle ${r.source}`, r.crmAt && `Registriert am ${new Date(r.crmAt).toLocaleDateString("de-DE")}${r.stage ? `, HubSpot: ${r.stage}` : ""}`].filter(Boolean).join("\n");
  const person = (r: Lead) => r.last ? [r.salutation, r.first, r.last].filter(Boolean).join(" ") : r.first;
  /* the page the lead was found on, shown as its domain; leads from the mailbox say E-Mail */
  const srcCell = (r: Lead) => {
    if (r.source === "Postfach") return "E-Mail";
    const u = httpUrl(r.sourceUrl);
    let host = ""; try { host = u ? new URL(u).hostname.replace(/^www\./, "") : ""; } catch {}
    return host ? <a className="srcl" href={u!} target="_blank" rel="noreferrer" title={u!} onClick={e => e.stopPropagation()}>{host}</a> : <span title={r.source}>{r.source}</span>;
  };
  const chCell = (r: Lead) => {
    const ch = chOf(r), title = r.sendpilotAt ? `In SendPilot seit ${new Date(r.sendpilotAt).toLocaleDateString("de-DE")}` : ch === "none" ? r.channelRec.text : `${ch === "mail" ? "E-Mail" : "LinkedIn"}: ${r.channel ? "von Hand gesetzt" : r.channelRec.text}`;
    return <td className={`c-ch${r.sendpilotAt ? " on" : ""}`} title={title}>{ch === "none" ? <span className="f3">–</span> : <Icon n={ch === "mail" ? "mail" : "linkedin"} />}</td>;
  };
  const day = (iso: string | null) => iso ? new Date(iso).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" }) : "";
  const none = <span className="f3">–</span>;
  const cols: Col[] = [
    { id: "c-sel", label: "Auswahl", fixed: true, head: <input type="checkbox" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(vis.map(r => r.id)))} aria-label="Alle auswählen" />,
      td: r => <td className="c-sel" onClick={e => e.stopPropagation()}><input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} aria-label={`${r.company} auswählen`} /></td> },
    { id: "c-q", label: "Verschieben", fixed: true, head: null, aria: "Verschieben", td: (_, handle) => <td className="c-q">{handle}</td> },
    { id: "c-day", label: "Versand", td: r => <td className="c-day f2">{dayCell(days[r.id])}</td> },
    { id: "c-rt", label: "Bewertung", filter: <Select className={`thf${grade !== "alle" ? " on" : ""}`} value={grade} onChange={setGrade} label="Note filtern" options={GRADES}><Icon n="list-filter" /></Select>,
      td: r => <td className="c-rt">{r.rating !== null && r.ratingInfo ? <RatingBar value={r.rating} title={[`${r.rating} von 100, Note ${r.ratingInfo.grade}${r.ratingInfo.type ? `, ${r.ratingInfo.type}` : ""}`, r.ratingInfo.why, ...r.ratingInfo.reasons.slice(0, 3).map(reasonText)].filter(Boolean).join("\n")} /> : none}</td> },
    { id: "warm", label: "Warm / Kalt", head: null, td: r => <td className={`warm${warm(r) ? "" : " f3"}`}>{warm(r) ? "Warm" : "Kalt"}</td> },
    { id: "c-ch", label: "Kanal", head: null, aria: "Kanal", td: chCell },
    { id: "dotc", label: "Status", head: null, aria: "Status", td: r => <td className="dotc"><Dot s={r.status} /></td> },
    { id: "co", label: "Firma", size: true, td: r => <td className="co" title={r.company}>{r.company || none}{r.companyId != null && (perCo.get(r.companyId) || 0) > 1 &&
      <button className="cnum" title={`${perCo.get(r.companyId)} Personen bei ${r.company || "dieser Firma"}`} onClick={e => { e.stopPropagation(); setCoF(r.companyId); }}>{perCo.get(r.companyId)}</button>}</td> },
    { id: "pn", label: "Ansprechpartner", size: true, td: r => <td className="pn" title={person(r) || undefined}>{person(r) || none}</td> },
    { id: "c-em", label: "E-Mail", size: true, td: r => <td className="c-em mono" title={r.email || (r.enrichMiss?.email ? `Websuche am ${new Date(r.enrichMiss.email).toLocaleDateString("de-DE")} ohne Treffer` : undefined)}>{r.email || <span className="f3">{contactsOf(r).some(x => x.email) ? "–" : r.enrichMiss?.email ? "nicht gefunden" : "fehlt"}</span>}</td> },
    { id: "c-tel", label: "Telefon", size: true, td: r => <td className="c-tel f2 num" title={r.phone || undefined}>{r.phone || none}</td> },
    { id: "c-city", label: "Ort", size: true, td: r => <td className="c-city f2" title={r.city || undefined}>{r.city || none}</td> },
    /* tenants with tenders see them in the dialog only */
    ...(t.tenders ? [] : [{ id: "c-hook", label: "Anlass", size: true, td: (r: Lead) => <td className="c-hook f2" title={r.hook || undefined}>{r.hook || <span className="f3">fehlt</span>}</td> }]),
    { id: "c-type", label: "Firmentyp", size: true, filter: ctypes.length > 0 && <Select className={`thf${ct !== "alle" ? " on" : ""}`} value={ct} onChange={setCtype} label="Firmentyp filtern"
      options={[["alle", "Alle Firmentypen"], ...ctypes.map(c => [c, c] as [string, string])]}><Icon n="list-filter" /></Select>,
      td: r => <td className="c-type f2" title={r.ratingInfo?.type || undefined}>{r.ratingInfo?.type || none}</td> },
    { id: "c-src", label: "Quelle", size: true, filter: <Select className={`thf${src !== "alle" ? " on" : ""}`} value={src} onChange={setSrc} label="Quelle filtern"
      options={[["alle", "Alle Quellen"], ...srcs.map(s => [s, s] as [string, string])]}><Icon n="list-filter" /></Select>, td: r => <td className="c-src f2">{srcCell(r)}</td> },
    { id: "c-kind", label: "Art", size: true, td: r => <td className="c-kind" title={kindTitle(r)}><KindTag k={kindOf(r)} /></td> },
    { id: "c-touch", label: "Kontakt", filter: <TouchFilter value={tf} onChange={setTf} />,
      td: r => <td className="c-touch" title={r.touch ? `${TOUCHES.filter(([k]) => r.touch![k]).map(([, l]) => l).join(", ") || "Kein persönlicher Kontakt"}` : undefined}>
        {r.touch && (r.touch.demo || r.touch.call || r.touch.mail) ? TOUCHES.filter(([k]) => r.touch![k]).map(([k, , ic]) => <Icon key={k} n={ic} />) : none}</td> },
    { id: "c-new", label: "Angelegt", td: r => <td className="c-new f2">{day(r.createdAt)}</td> },
    { id: "act", label: "Aktionen", fixed: true, head: null, td: r => <td className="act">{r.status !== "papierkorb" && r.rating !== null && <>
      <button className={`btn gh ic${r.vote > 0 ? " on" : ""}`} title="Guter Lead" aria-label="Guter Lead" aria-pressed={r.vote > 0} onClick={e => { e.stopPropagation(); vote(r, 1); }}><Icon n="thumbs-up" /></button>
      <button className={`btn gh ic${r.vote < 0 ? " on" : ""}`} title="Schlechter Lead" aria-label="Schlechter Lead" aria-pressed={r.vote < 0} onClick={e => { e.stopPropagation(); vote(r, -1); }}><Icon n="thumbs-down" /></button>
    </>}{r.status === "papierkorb"
      ? <button className="btn gh ic" title="Wiederherstellen" aria-label="Wiederherstellen" onClick={e => { e.stopPropagation(); trash(r, true); }}><Icon n="undo-2" /></button>
      : <button className="btn gh ic" title="In den Papierkorb" aria-label="In den Papierkorb" onClick={e => { e.stopPropagation(); trash(r); }}><Icon n="trash-2" /></button>}</td> },
  ];
  /* the movable columns in the order chosen, ones not in a saved order at the end; the table keeps the fixed ones at the edges */
  const movable = cols.filter(c => !c.fixed).map(c => c.id);
  const colSeq = [...colOrder.filter(id => movable.includes(id)), ...movable.filter(id => !colOrder.includes(id))];
  const grid = useReactTable({ data: shownRows, columns: cols.map(c => ({ id: c.id, enableHiding: !c.fixed })), getCoreRowModel: getCoreRowModel(), getRowId: r => String(r.id),
    state: { columnVisibility: colVis, columnOrder: ["c-sel", "c-q", ...colSeq, "act"] }, onColumnVisibilityChange: u => setCols(functionalUpdate(u, colVis), colSeq) });
  const colById = new Map(cols.map(c => [c.id, c]));
  const shownCols = grid.getVisibleLeafColumns().map(c => colById.get(c.id)!);
  /* a row the pointer rests on starts loading its dialog; passing over rows does not, as each load asks HubSpot a dozen times */
  const rowProps = (r: Lead) => ({ className: `click${dayEnd.has(r.id) ? " cut" : ""}${flash.has(r.id) ? " flash" : ""}`, tabIndex: 0, onClick: () => setEdit(r),
    onPointerEnter: () => { clearTimeout(hover.current); hover.current = setTimeout(() => prefetchLead(r.id), 150); }, onPointerLeave: () => clearTimeout(hover.current),
    onKeyDown: (e: React.KeyboardEvent<HTMLTableRowElement>) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setEdit(r); } } });
  const cells = (r: Lead, handle: ReactNode) => shownCols.map(c => <Fragment key={c.id}>{c.td(r, handle)}</Fragment>);
  const row = (r: Lead) => canDrag && pos.has(r.id)
    ? <QueueRow key={r.id} id={r.id} {...rowProps(r)}>{h => cells(r, h)}</QueueRow>
    : <tr key={r.id} {...rowProps(r)}>{cells(r, null)}</tr>;

  /* the ticked leads, else all in view, in the order shown */
  function csv() {
    const list = picked.length ? vis.filter(r => sel.has(r.id)) : vis;
    const lines = [["Firma", "Anrede", "Vorname", "Nachname", "Rolle", "E-Mail", "Telefon", "LinkedIn", "Website", "Ort", "Status", "Bewertung", "Note", "Firmentyp", "Persönlicher Kontakt", "Quelle", "Art", "Registriert", "Letzter Kontakt", "Angelegt", "Notiz"],
      ...list.map(r => [r.company, r.salutation, r.first, r.last, r.role, r.email, r.phone, r.linkedin, r.website, r.city, STATUS[r.status]?.[0] || r.status, r.rating ?? "", r.ratingInfo?.grade ?? "", r.ratingInfo?.type ?? "",
        r.touch ? TOUCHES.filter(([k]) => r.touch![k]).map(([, l]) => l).join(", ") : "", r.source, KIND_LABEL[kindOf(r)], day(r.crmAt), day(r.lastContactAt), day(r.createdAt), r.note])];
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([toCsv(lines)], { type: "text/csv;charset=utf-8" })); a.download = `leads-${t.slug}-${berlinDate()}.csv`; a.click();
  }

  const ok = imp?.rows?.filter(r => !r.dup).length || 0;
  const table = imp?.cols && !imp.rows ? splitTable(imp.text) : null;
  return <>
    <Top title="Leads" onMenu={ctx.openSidebar}>
      {ctx.st.integ.sendpilot?.on && <button className="btn sec" onClick={openLi}><Icon n="linkedin" />LinkedIn</button>}
      {job ? <div className="enr" role="status" aria-label="Anreichern">
        <button className="enr-run" onClick={() => setLive(true)} title="Zwischenstand ansehen">
          <div className="bar"><i style={{ width: `${job.total ? job.done / job.total * 100 : 0}%` }} /></div>
          <span className="num">{job.done}/{job.total}</span><span className="f3 num">{job.found} gefunden</span>
        </button>
        <button className="btn gh ic" title="Stoppen" aria-label="Stoppen" onClick={stopEnrich}><Icon n="square" /></button>
      </div> : <button className="btn sec" onClick={openEnrich}><Icon n="sparkles" />Anreichern{picked.length > 0 && <span className="num f3">{picked.length}</span>}</button>}
      <button className="btn sec" onClick={csv} disabled={!vis.length}><Icon n="download" /><span className="hide-m">Export</span>{picked.length > 0 && <span className="num f3">{picked.length}</span>}</button>
      <button className="btn sec" onClick={() => setAngles(true)}><Icon n="target" />Suchrichtungen</button>
      <button className="btn sec" onClick={() => setEdit(emptyLead())}><Icon n="plus" />Kontakt</button>
      <button className="btn pri" onClick={() => { setImp({ text: "", src: "", rows: null, busy: false }); setSheets(null); }}><Icon n="upload" />Importieren</button>
    </Top>
    <div className="scroll"><div className="wrap wide full lc-room">
      <div className="toolbar">
        <div className="filters">
          {/* Leads, CRM or both, and people or companies, as tabs that open a choice */}
          <Select className={`ftab${kind !== "alle" ? " on" : ""}`} value={kind} onChange={v => setKind(v as KindFilter)} label="Leads oder CRM" options={KINDS} />
          <Select className="ftab" value={level} onChange={setLevel} label="Personen oder Firmen" options={LEVELS} />
          <span className="fsep" aria-hidden />
          <Select className={`ftab${filter !== "alle" ? " on" : ""}`} value={filter} onChange={setFilter} label="Status"
            options={FILTERS.map(k => [k, <>{k !== "alle" && <Dot s={k} />}{k === "alle" ? "Alle" : STATUS[k][0]}<span className="c">{cnt(k)}</span></>])} />
          {/* filters set in a column header, shown here too so they stay visible in the companies view and while their column is hidden */}
          {([[grade !== "alle", GRADES.find(([k]) => k === grade)?.[1], () => setGrade("alle"), "Notenfilter"], [ct !== "alle", ct, () => setCtype("alle"), "Firmentypfilter"],
            [tf.length > 0, TOUCH_OPTS.filter(([k]) => tf.includes(k)).map(([, l]) => l).join(", "), () => setTf([]), "Kontaktfilter"], [src !== "alle", `Quelle: ${src}`, () => setSrc("alle"), "Quellenfilter"]] as const)
            .map(([on, l, clear, what]) => on && <span key={what} className="chip">{l}<button onClick={clear} aria-label={`${what} entfernen`}><Icon n="x" /></button></span>)}
          {coF != null && <span className="chip">{(cos.find(c => c.id === coF)?.name || rows.find(r => r.companyId === coF)?.company || "Firma")}<button onClick={() => setCoF(null)} aria-label="Firmenfilter entfernen"><Icon n="x" /></button></span>}
        </div>
        <div className="row3">
          <Select className="inp sel" value={sort} onChange={setSort} label="Sortieren" options={SORTS} />
          {level === "person" && <ColPicker cols={colSeq.map(id => ({ id, label: colById.get(id)!.label, on: colVis[id] !== false }))}
            onToggle={id => grid.getColumn(id)?.toggleVisibility()} onMove={ids => setCols(colVis, ids)} onReset={() => setCols(COLS_OFF, [])} />}
          <div className="search"><Icon n="search" /><input className="inp" placeholder="Firma, Person, E-Mail" value={q} onChange={e => setQ(e.target.value)} aria-label="Suchen" /></div>
        </div>
      </div>
      {level === "firma" ? <div className="tbl"><table className="leads firms"><thead><tr><th className="co">Firma</th><th className="c-n">Personen</th><th className="pn">Ansprechpartner</th><th className="c-st">Status</th><th className="c-dom">Domain</th><th className="c-src">Quelle</th><th className="c-kind">Art</th><th className="c-last">Letzter Kontakt</th></tr></thead><tbody>
        {firms.length ? firms.slice(0, shown).map(f => <tr key={f.key} className="click" tabIndex={0} onClick={() => openFirm(f)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFirm(f); } }}>
          <td className="co" title={f.name}>{f.name || <span className="f3">–</span>}</td>
          <td className="c-n num">{f.people.length}</td>
          <td className="pn" title={f.people.map(person).filter(Boolean).join(", ")}>{f.people.map(r => person(r) || r.email).filter(Boolean).slice(0, 3).join(", ") || <span className="f3">–</span>}{f.people.length > 3 && <span className="f3"> +{f.people.length - 3}</span>}</td>
          <td className="c-st">{[...new Set(f.people.map(r => r.status))].map(st => <Dot key={st} s={st} />)}</td>
          <td className="c-dom f2">{f.domain || <span className="f3">–</span>}</td>
          <td className="c-src f2" title={f.sources.join(", ")}>{f.sources.join(", ")}</td>
          <td className="c-kind"><KindTag k={kindOfAll(f.people)} /></td>
          <td className="c-last f2">{f.last ? new Date(f.last).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" }) : <span className="f3">–</span>}</td>
        </tr>) : <tr><td colSpan={8} className="f3" style={{ padding: "32px 0", textAlign: "center" }}>{rows.length ? "Keine Treffer." : "Noch keine Leads."}</td></tr>}
        {shown < firms.length && <tr ref={more} aria-hidden><td colSpan={8} className="f3" style={{ padding: "16px 0", textAlign: "center" }}>{shown} von {firms.length}</td></tr>}
      </tbody></table></div> :
      <div className="tbl"><table className="leads" style={Object.fromEntries(Object.entries(widths).map(([k, w]) => [`--w-${k}`, `${w}px`]))}><thead><tr>
        {shownCols.map(c => <th key={c.id} className={c.id} aria-label={c.aria}>{c.head !== undefined ? c.head : <div className="thc"><span>{c.label}</span>{c.filter}</div>}
          {c.size && <span className="rsz" aria-hidden onPointerDown={e => resize(c.id, e)} onDoubleClick={() => unsize(c.id)} />}</th>)}</tr></thead><tbody>
        {vis.length ? <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={moved} accessibility={{ container: typeof document === "undefined" ? undefined : document.body }}>
          <SortableContext items={canDrag ? shownRows.filter(r => pos.has(r.id)).map(r => r.id) : []} strategy={verticalListSortingStrategy}>{grid.getRowModel().rows.map(x => row(x.original))}</SortableContext>
        </DndContext> :<tr><td colSpan={shownCols.length} className="f3" style={{ padding: "32px 0", textAlign: "center" }}>{rows.length ? "Keine Treffer." : "Noch keine Leads."}</td></tr>}
        {shown < vis.length && <tr ref={more} aria-hidden><td colSpan={shownCols.length} className="f3" style={{ padding: "16px 0", textAlign: "center" }}>{shown} von {vis.length}</td></tr>}
      </tbody></table></div>}
    </div></div>
    <LeadChat slug={t.slug} onChanged={chatChanged} toast={ctx.toast} />

    {edit && <LeadDialog key={edit.id ?? `new-${edit.company}`} lead={edit} slug={t.slug} tenders={t.tenders}
      rating={"ratingInfo" in edit ? rows.find(x => x.id === edit.id) : undefined} miss={rows.find(x => x.id === edit.id)?.enrichMiss}
      onEnriched={(id, found) => { setRows(rs => rs.map(x => x.id === id ? { ...x, ...found } : x)); load(); }} onVote={v => { const r = rows.find(x => x.id === edit.id); if (r) vote(r, v); }}
      co={"companyId" in edit ? coOf(edit as Lead) : undefined} contacts={"companyId" in edit ? contactsOf(edit as Lead) : []} onClose={() => setEdit(null)}
      onSaved={() => { setEdit(null); ctx.toast("Gespeichert"); load(); }}
      onDeleted={() => { setEdit(null); ctx.toast("Gelöscht"); load(); }}
      onTrash={() => { const r = edit as Lead; setEdit(null); trash(r); }}
      onAdd={co => { const r = edit; setEdit({ ...emptyLead(co), city: r.city, website: r.website }); }}
      onOpen={id => { const r = rows.find(x => x.id === id); if (r) setEdit(r); }} />}

    {li && <div className="ov" onClick={e => e.target === e.currentTarget && setLi(null)}><div className="dlg" ref={liRef} role="dialog" aria-modal="true" aria-label="An SendPilot geben">
      <div className="dlg-h">An SendPilot geben<button className="btn gh ic" onClick={() => setLi(null)} aria-label="Schließen"><Icon n="x" /></button></div>
      {!li.campaigns ? <Icon n="loader" /> : li.campaigns.length ? <label className="fld"><span>Kampagne</span>
        <select className="inp" value={li.id} onChange={e => setLi({ ...li, id: e.target.value })}>{li.campaigns.map(c => <option key={c.id} value={c.id}>{c.name} ({c.totalLeads})</option>)}</select></label>
        : <div className="warn">In SendPilot gibt es keine offene Kampagne.</div>}
      <button className="btn pri wide" onClick={pushLi} disabled={li.busy || !li.id || !liLeads.length}>{li.busy && <Icon n="loader" />}{liLeads.length} {liLeads.length === 1 ? "Lead" : "Leads"} mit LinkedIn übergeben</button>
    </div></div>}

    {enr && (() => { const n = enrichable(enr).length, before = missedBefore(enr);
      return <div className="ov" onClick={e => e.target === e.currentTarget && setEnr(null)}><div className="dlg" ref={enrRef} role="dialog" aria-modal="true" aria-label="Kontakte anreichern">
        <div className="dlg-h">Kontakte anreichern<button className="btn gh ic" onClick={() => setEnr(null)} aria-label="Schließen"><Icon n="x" /></button></div>
        {picked.length > 0 && <div className="fld"><span>Leads</span><div className="row3">
          <label className="ck"><input type="radio" name="enr-scope" checked={enr.picked} onChange={() => setEnr({ ...enr, picked: true })} />Ausgewählte ({picked.length})</label>
          <label className="ck"><input type="radio" name="enr-scope" checked={!enr.picked} onChange={() => setEnr({ ...enr, picked: false })} />Alle in der Ansicht ({vis.length})</label>
        </div></div>}
        <div className="fld"><span>Im Web suchen nach</span><div className="ckg">
          {ENRICH.map(([k, l]) => <label key={k} className="ck"><input type="checkbox" checked={enr.fields.includes(k)}
            onChange={() => setEnr({ ...enr, fields: enr.fields.includes(k) ? enr.fields.filter(f => f !== k) : [...enr.fields, k] })} />{l}</label>)}
        </div></div>
        {before > 0 && <label className="ck"><input type="checkbox" checked={enr.again} onChange={() => setEnr({ ...enr, again: !enr.again })} />{before} {before === 1 ? "Lead" : "Leads"} ohne Treffer bei früherer Suche erneut prüfen</label>}
        <button className="btn pri wide" onClick={runEnrich} disabled={!n}>{n} {n === 1 ? "Lead" : "Leads"} anreichern</button>
      </div></div>; })()}

    {live && job && !edit && <EnrichReport done={job.results} skipped={job.skipped} stopped={false} live={{ done: job.done, total: job.total }} onClose={() => setLive(false)} onOpen={id => { const r = rows.find(x => x.id === id); if (r) setEdit(r); }} />}
    {report && !edit && <EnrichReport {...report} onClose={() => setReport(null)} onOpen={id => { const r = rows.find(x => x.id === id); if (r) setEdit(r); }} />}

    {angles && <AnglesDialog slug={t.slug} toast={ctx.toast} onClose={() => setAngles(false)} />}

    {imp && <div className="ov" onClick={e => e.target === e.currentTarget && setImp(null)}><div className="dlg imp" ref={impRef} role="dialog" aria-modal="true" aria-label="Importieren">
      {imp.cols && !imp.rows ? <>
        <div className="dlg-h">Spalten zuordnen<button className="btn gh ic" onClick={() => setImp(null)} aria-label="Schließen"><Icon n="x" /></button></div>
        {sheets && <select className="inp sel" aria-label="Blatt" value={sheets.i} onChange={e => pickSheet(Number(e.target.value))} disabled={imp.busy}>{sheets.list.map((s, i) => <option key={i} value={i}>{s.sheet}</option>)}</select>}
        {/* one line per source column; unassigned ones stay folded so the list shows what goes into the CRM */}
        <div className="tbl"><table className="map"><tbody>
          {imp.cols.map((c, i) => !c.field && !allCols ? null : <tr key={i} className={c.field ? "" : "off"}>
            <td className="mh" title={c.head}>{c.head || "–"}</td>
            <td className="ms f3" title={c.samples[0]}>{c.samples[0] ? clean(c.samples[0]) : "leer"}</td>
            <td className="mf"><select className={`inp sel${c.field ? "" : " off"}`} aria-label={`Feld für ${c.head}`} value={c.field} onChange={e => setField(i, e.target.value as Field)}>
              <option value="">Ignorieren</option>
              {Object.entries(FIELDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></td>
          </tr>)}
        </tbody></table>
        {imp.cols.some(c => !c.field) && <button className="btn gh more" onClick={() => setAllCols(!allCols)}>{allCols ? "Ignorierte ausblenden" : `${imp.cols.filter(c => !c.field).length} ignorierte ${imp.cols.filter(c => !c.field).length === 1 ? "Spalte" : "Spalten"}`}</button>}</div>
        <div className="dlg-f">{table && <span className="f3">{table.rows.length} {table.rows.length === 1 ? "Zeile" : "Zeilen"}</span>}<span className="sp" />
          <button className="btn sec" onClick={() => { setImp({ ...imp, cols: null }); setSheets(null); }}>Zurück</button><button className="btn pri" onClick={mapped} disabled={imp.busy}>{imp.busy && <Icon n="loader" />}Kontakte erkennen</button></div>
      </> : !imp.rows ? <>
        <div className="dlg-h">Leads importieren<button className="btn gh ic" onClick={() => setImp(null)} aria-label="Schließen"><Icon n="x" /></button></div>
        <label className={`drop${drag ? " on" : ""}`} onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files[0]); }}>
          {imp.busy ? <Icon n="loader" /> : <Icon n="upload" />}<span>Excel-, CSV- oder Markdown-Datei hierher ziehen oder <u>auswählen</u></span>
          <input type="file" accept=".xlsx,.csv,.md" className="vh" onChange={e => { pick(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        <label className="fld"><span>Oder Text einfügen</span><textarea className="prompt" style={{ minHeight: 88 }} placeholder="Liste, Tabelle oder Text einfügen" value={imp.text} autoFocus
          onChange={e => setImp({ ...imp, text: e.target.value })}
          /* a pasted table goes straight to the column view */
          onPaste={e => { const txt = e.clipboardData.getData("text"); if (!imp.text.trim() && splitTable(txt)) { e.preventDefault(); setImp({ ...imp, text: txt }); setSheets(null); analyze(txt); } }} /></label>
        <button className="btn pri wide" onClick={() => analyze(imp.text)} disabled={imp.busy || !imp.text.trim()}>{imp.busy && <Icon n="loader" />}Daten erkennen</button>
      </> : <>
        <div className="dlg-h">{imp.rows.length} {imp.rows.length === 1 ? "Kontakt" : "Kontakte"} erkannt<button className="btn gh ic" onClick={() => setImp(null)} aria-label="Schließen"><Icon n="x" /></button></div>
        <div className="tbl"><table><thead><tr><th>Firma</th><th>Ansprechpartner</th><th className="hide-m">Rolle</th><th>E-Mail</th><th className="hide-m">Telefon</th><th className="hide-m">Ort</th><th></th></tr></thead><tbody>
          {imp.rows.map((r, i) => <tr key={i}><td style={{ fontWeight: 500 }}>{r.co}</td><td>{r.p ? [r.sal, r.p].filter(Boolean).join(" ") : <span className="f3">–</span>}</td>
            <td className="hide-m f2" title={r.note || undefined}>{r.role || <span className="f3">–</span>}</td>
            <td className="mono" style={{ fontSize: 12.5 }}>{r.email || (r.web ? <span className="f3">{r.web}</span> : <span className="f3">fehlt</span>)}</td>
            <td className="hide-m f2 num">{r.phone || <span className="f3">–</span>}</td>
            <td className="hide-m f2">{r.city || <span className="f3">–</span>}</td>
            <td>{r.dup ? <span className="pill">{r.dup}</span> : r.extra ? <span className="pill">{r.extra}</span> : null}</td></tr>)}
        </tbody></table></div>
        <div className="dlg-f"><input className="inp" style={{ width: 220 }} aria-label="Quelle" value={imp.src} placeholder="Quelle, z. B. DTVP Oktober" onChange={e => setImp({ ...imp, src: e.target.value, auto: false })} /><span className="sp" />
          <button className="btn sec" onClick={() => setImp({ ...imp, rows: null })}>Zurück</button><button className="btn pri" onClick={save} disabled={!ok}>{ok} {ok === 1 ? "Lead" : "Leads"} übernehmen</button></div>
      </>}
    </div></div>}
  </>;
}
