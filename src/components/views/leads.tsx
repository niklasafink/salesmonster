"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { EnrichField, RatingInfo, Tender } from "@/db/schema";
import { Icon, Top, api, useDialog } from "../ui";
import { hasField, httpUrl } from "@/lib/lead-fields";
import { EnrichReport, type EnrichDone } from "../enrich-report";
/* a background enrich run as /api/leads/enrich/jobs reports it */
type EnrichJob = { id: number; status: string; error: string; total: number; done: number; found: number; skipped: number; results: EnrichDone[] };
import { ENRICH, LeadDialog, RatingBar, STATUS, emptyLead, type EditLead } from "../lead-dialog";
import { AnglesDialog } from "../angles-dialog";
import { LeadChat, type ChatChange } from "../lead-chat";
import type { Ctx } from "../types";
import { FIELDS, clean, splitTable, type Column, type Field } from "@/lib/lead-columns";
import { mdTable, parseCsv, toCsv, toTsv } from "@/lib/sheet";
import { addDaysIso, berlinDate } from "@/lib/dates";
import { DAY_NAMES, isoWeekday } from "@/lib/schedule";

type Lead = EditLead & { id: number; companyId: number | null; source: string; tenders: Tender[]; lastContactAt: string | null; createdAt: string; rating: number | null; ratingInfo: RatingInfo | null; vote: number; enrichMiss: Partial<Record<EnrichField, string>>;
  channelRec: { ch: "mail" | "linkedin" | "none"; text: string }; sendpilotAt: string | null };
type Sheet = { sheet: string; data: unknown[][] };
type Company = { id: number; name: string; mode: string; email: string };
type Campaign = { id: string; name: string; status: string; totalLeads: number };
type Parsed = { co: string; sal?: string; p: string; role: string; email: string; phone?: string; web: string; city: string; note?: string; dup: string; extra: string };
const FILTERS = ["alle", "neu", "freigabe", "angeschrieben", "beantwortet", "unzustellbar", "dublette", "kontakt", "papierkorb"];

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
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [sort, setSortState] = useState("versand"), [angles, setAngles] = useState(false);
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
  const th = (k: string, label: ReactNode) => <th className={k}>{label}<span className="rsz" aria-hidden onPointerDown={e => resize(k, e)} onDoubleClick={() => unsize(k)} /></th>;
  const setSort = (v: string) => { setSortState(v); keep.set("leads-sort", v); };
  const impRef = useDialog(() => setImp(null));
  /* only the newest read is shown: an older answer that arrives late never overwrites a newer one */
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    return api<{ rows: Lead[]; companies: Company[]; order: number[]; next: number[]; days: Record<number, string> }>(`/api/leads?t=${t.slug}`)
      .then(r => { if (n !== seq.current) return; setRows(r.rows); setCos(r.companies); setOrder(r.order); setDays(r.days || {}); })
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
  const inFilter = (r: Lead, s: string) => s === "alle" ? r.status !== "papierkorb" : r.status === s;
  const cnt = (s: string) => rows.filter(r => inFilter(r, s)).length;
  /* Versand: by send day, drafts waiting for approval included; within a day the queue order, where further contacts of a company
     follow its first one, as the evening run takes them; leads without a day come last by rating */
  const coId = new Map(rows.map(r => [r.id, r.companyId == null ? `l${r.id}` : `c${r.companyId}`]));
  const first = new Map<string, number>();
  order.forEach((id, i) => { const c = coId.get(id) ?? `l${id}`; if (!first.has(c)) first.set(c, i); });
  const queue = order.map((id, i) => ({ id, k: first.get(coId.get(id) ?? `l${id}`)!, i })).sort((a, b) => a.k - b.k || a.i - b.i).map(x => x.id);
  const pos = new Map(queue.map((id, i) => [id, i]));
  const byQueue = (a: Lead, b: Lead) => (days[a.id] || "9").localeCompare(days[b.id] || "9") || (pos.get(a.id) ?? Infinity) - (pos.get(b.id) ?? Infinity) || sorters.bewertung(a, b);
  const vis = rows.filter(r => inFilter(r, filter) && (src === "alle" || r.source === src) && matches(`${r.company} ${r.first} ${r.last} ${r.email}`, q)).sort(sort === "versand" ? byQueue : sorters[sort]);
  /* dragging only where the whole queue is in view, so a move means the same as in the list */
  const canDrag = sort === "versand" && src === "alle" && !q.trim() && (filter === "alle" || filter === "neu");
  /* a line under the last lead of each send day */
  const dayEnd = new Set(sort === "versand" ? vis.filter((r, i) => days[r.id] && days[vis[i + 1]?.id] !== days[r.id]).map(r => r.id) : []);
  async function moved(e: DragEndEvent) {
    const from = queue.indexOf(Number(e.active.id)), to = e.over ? queue.indexOf(Number(e.over.id)) : -1;
    if (from < 0 || to < 0 || from === to) return;
    const nx = arrayMove(queue, from, to);
    setOrder(nx);
    /* the moved block keeps its places; what follows stays sorted by rating */
    try { await api("/api/leads/queue", { method: "PUT", body: { t: t.slug, ids: nx.slice(0, Math.max(from, to) + 1) } }); load(); }
    catch (err) { ctx.toast((err as Error).message, { error: true }); load(); }
  }

  const coOf = (r: Lead) => r.companyId ? cos.find(c => c.id === r.companyId) : undefined;
  const contactsOf = (r: Lead) => r.companyId ? rows.filter(x => x.companyId === r.companyId) : [r];

  /* the trash keeps the lead, so research and import recognise it and nobody writes to it */
  async function trash(r: Lead, back = false) {
    const status = back ? (warm({ ...r, status: "" }) ? "kontakt" : "neu") : "papierkorb";
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

  const person = (r: Lead) => r.last ? [r.salutation, r.first, r.last].filter(Boolean).join(" ") : r.first;
  const hookCell = (r: Lead) => t.tenders ? (r.tenders.length ? `${r.tenders.length} Ausschreibung${r.tenders.length > 1 ? "en" : ""}` : <span className="f3">fehlt</span>) : r.hook || <span className="f3">fehlt</span>;
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
  const cells = (r: Lead, handle: ReactNode) => <>
    <td className="c-sel" onClick={e => e.stopPropagation()}><input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} aria-label={`${r.company} auswählen`} /></td>
    <td className="c-q">{handle}</td>
    <td className="c-day f2">{dayCell(days[r.id])}</td>
    <td className="c-rt">{r.rating !== null && r.ratingInfo ? <RatingBar value={r.rating} title={[`${r.rating} von 100`, ...r.ratingInfo.reasons.slice(0, 3).map(reasonText)].join("\n")} /> : <span className="f3">–</span>}</td>
    <td className={`warm${warm(r) ? "" : " f3"}`}>{warm(r) ? "Warm" : "Kalt"}</td>
    {chCell(r)}
    <td className="dotc"><Dot s={r.status} /></td>
    <td className="co" title={r.company}>{r.company}</td>
    <td className="pn" title={person(r) || undefined}>{person(r) || <span className="f3">–</span>}</td>
    <td className="c-role f2" title={r.role || undefined}>{r.role || <span className="f3">–</span>}</td>
    <td className="c-em mono" title={r.email || (r.enrichMiss?.email ? `Websuche am ${new Date(r.enrichMiss.email).toLocaleDateString("de-DE")} ohne Treffer` : undefined)}>{r.email || <span className="f3">{contactsOf(r).some(x => x.email) ? "–" : r.enrichMiss?.email ? "nicht gefunden" : "fehlt"}</span>}</td>
    <td className="c-hook f2" title={t.tenders ? undefined : r.hook || undefined}>{hookCell(r)}</td>
    <td className="c-src f2">{srcCell(r)}</td>
    <td className="act">{r.status !== "papierkorb" && r.rating !== null && <>
      <button className={`btn gh ic${r.vote > 0 ? " on" : ""}`} title="Guter Lead" aria-label="Guter Lead" aria-pressed={r.vote > 0} onClick={e => { e.stopPropagation(); vote(r, 1); }}><Icon n="thumbs-up" /></button>
      <button className={`btn gh ic${r.vote < 0 ? " on" : ""}`} title="Schlechter Lead" aria-label="Schlechter Lead" aria-pressed={r.vote < 0} onClick={e => { e.stopPropagation(); vote(r, -1); }}><Icon n="thumbs-down" /></button>
    </>}{r.status === "papierkorb"
      ? <button className="btn gh ic" title="Wiederherstellen" aria-label="Wiederherstellen" onClick={e => { e.stopPropagation(); trash(r, true); }}><Icon n="undo-2" /></button>
      : <button className="btn gh ic" title="In den Papierkorb" aria-label="In den Papierkorb" onClick={e => { e.stopPropagation(); trash(r); }}><Icon n="trash-2" /></button>}</td>
  </>;
  const rowProps = (r: Lead) => ({ className: `click${dayEnd.has(r.id) ? " cut" : ""}${flash.has(r.id) ? " flash" : ""}`, tabIndex: 0, onClick: () => setEdit(r),
    onKeyDown: (e: React.KeyboardEvent<HTMLTableRowElement>) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setEdit(r); } } });
  const row = (r: Lead) => canDrag && pos.has(r.id)
    ? <QueueRow key={r.id} id={r.id} {...rowProps(r)}>{h => cells(r, h)}</QueueRow>
    : <tr key={r.id} {...rowProps(r)}>{cells(r, null)}</tr>;

  /* the ticked leads, else all in view, in the order shown */
  function csv() {
    const list = picked.length ? vis.filter(r => sel.has(r.id)) : vis;
    const day = (iso: string | null) => iso ? new Date(iso).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" }) : "";
    const lines = [["Firma", "Anrede", "Vorname", "Nachname", "Rolle", "E-Mail", "Telefon", "LinkedIn", "Website", "Ort", "Status", "Bewertung", "Quelle", "Letzter Kontakt", "Angelegt", "Notiz"],
      ...list.map(r => [r.company, r.salutation, r.first, r.last, r.role, r.email, r.phone, r.linkedin, r.website, r.city, STATUS[r.status]?.[0] || r.status, r.rating ?? "", r.source, day(r.lastContactAt), day(r.createdAt), r.note])];
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
        <div className="filters">{FILTERS.map(k => <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{k !== "alle" && <Dot s={k} />}{k === "alle" ? "Alle" : STATUS[k][0]}<span className="c">{cnt(k)}</span></button>)}</div>
        <div className="row3">
          <select className="inp sel" value={sort} onChange={e => setSort(e.target.value)} aria-label="Sortieren">{SORTS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
          <select className="inp sel" value={src} onChange={e => setSrc(e.target.value)} aria-label="Quelle"><option value="alle">Alle Quellen</option>{srcs.map(s => <option key={s}>{s}</option>)}</select>
          <div className="search"><Icon n="search" /><input className="inp" placeholder="Firma, Person, E-Mail" value={q} onChange={e => setQ(e.target.value)} aria-label="Suchen" /></div>
        </div>
      </div>
      <div className="tbl"><table className="leads" style={Object.fromEntries(Object.entries(widths).map(([k, w]) => [`--w-${k}`, `${w}px`]))}><thead><tr><th className="c-sel"><input type="checkbox" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(vis.map(r => r.id)))} aria-label="Alle auswählen" /></th><th className="c-q" aria-label="Verschieben"></th><th className="c-day">Versand</th><th className="c-rt">Bewertung</th><th className="warm"></th><th className="c-ch" aria-label="Kanal"></th><th className="dotc"></th>{th("co", "Firma")}{th("pn", "Ansprechpartner")}{th("c-role", "Rolle")}{th("c-em", "E-Mail")}{th("c-hook", t.tenders ? "Ausschreibungen" : "Anlass")}{th("c-src", "Quelle")}<th className="act"></th></tr></thead><tbody>
        {vis.length ? <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={moved}>
          <SortableContext items={canDrag ? vis.filter(r => pos.has(r.id)).map(r => r.id) : []} strategy={verticalListSortingStrategy}>{vis.map(row)}</SortableContext>
        </DndContext> : <tr><td colSpan={14} className="f3" style={{ padding: "32px 0", textAlign: "center" }}>{rows.length ? "Keine Treffer." : "Noch keine Leads."}</td></tr>}
      </tbody></table></div>
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
