"use client";
import { useEffect, useRef, useState } from "react";
import type { EnrichField, Tender } from "@/db/schema";
import { addrsOf, modeOf } from "@/lib/company-mode";
import { SALUTATIONS, hasField, httpUrl } from "@/lib/lead-fields";
import { Icon, api, useDialog } from "./ui";

export type EditLead = {
  id?: number; company: string; salutation: string; first: string; last: string; role: string; email: string; emailType: string; phone: string;
  linkedin: string; website: string; city: string; hook: string; note: string; sourceUrl: string; research: string; status: string; tenders: Tender[]; source?: string;
  /* mail | linkedin set by hand, "" = as recommended */
  channel?: string; channelRec?: { ch: string; text: string };
};

/* what the web search can fill in, in the order the form shows it */
export const ENRICH: [EnrichField, string][] = [["person", "Ansprechpartner"], ["role", "Rolle"], ["email", "E-Mail"], ["phone", "Telefon"], ["linkedin", "LinkedIn"], ["website", "Website"], ["city", "Ort"]];

type Found = Partial<Pick<EditLead, "salutation" | "first" | "last" | "role" | "email" | "phone" | "linkedin" | "website" | "city">>;

export const STATUS: Record<string, [string, string]> = {
  neu: ["Neu", "n"], freigabe: ["In Freigabe", "a"], angeschrieben: ["Angeschrieben", "b"], beantwortet: ["Beantwortet", "g"], unzustellbar: ["Unzustellbar", "r"], dublette: ["Dublette", "x"], kontakt: ["Kontakt", "k"], papierkorb: ["Papierkorb", "t"],
};

/* rating 0–100 as ten segments, red to green by position; filled up to the score, the rest grey */
export const RatingBar = ({ value, title }: { value: number; title?: string }) => {
  const on = Math.max(value > 0 ? 1 : 0, Math.round(value / 10));
  return <span className="rbar" role="img" aria-label={`Bewertung ${value} von 100`} title={title}>
    {Array.from({ length: 10 }, (_, i) => <i key={i} className={i < on ? `s${i}` : undefined} />)}
  </span>;
};

export const emptyLead = (company = ""): EditLead => ({ company, salutation: "", first: "", last: "", role: "", email: "", emailType: "person", phone: "", linkedin: "", website: "",
  city: "", hook: "", note: "", sourceUrl: "", research: "", status: "neu", tenders: [] });

const tendersText = (ts: Tender[] = []) => ts.map(x => [x.t, x.s, x.f].filter(Boolean).join(" | ")).join("\n");
const tendersOf = (s: string): Tender[] => s.split("\n").map(r => r.split("|").map(x => x.trim())).filter(r => r[0]).map(([t, s = "", f = ""]) => ({ t, s, f }));

type Co = { id: number; mode: string; email: string };
type Mate = { id?: number; first: string; last: string; role: string; email: string; status: string };
type Act = { at: string; kind: string; title: string; text?: string; by?: string };

const ACT_ICON: Record<string, string> = { sent: "send", reply: "mail", bounce: "triangle-alert", draft: "file-text", mailbox: "inbox", created: "plus", linkedin: "linkedin" };
const when = (iso: string) => new Date(iso).toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Berlin" });
const nameOf = (x: { first: string; last: string }) => [x.first, x.last].filter(Boolean).join(" ");

/* label left, value right; the input only shows as one on hover and focus */
const Prop = ({ l, link, children }: { l: string; link?: string; children: React.ReactNode }) => <div className="prop">
  <label><span className="pk">{l}</span>{children}</label>
  {link && <a className="pa" href={link} target={link.startsWith("http") ? "_blank" : undefined} rel="noreferrer" aria-label={`${l} öffnen`}><Icon n="external-link" /></a>}
</div>;

/* Web search for the empty fields of one saved lead, also ones an earlier search missed; what it finds is saved right away and goes into the form, the menu then says what it found and what not.
   Fields an earlier search came back empty for are not ticked; ticking one searches again */
function EnrichMenu({ lead, slug, miss = {}, onFound }: { lead: EditLead; slug: string; miss?: Partial<Record<EnrichField, string>>; onFound: (found: Found) => void }) {
  const empty = ENRICH.filter(([k]) => !hasField(lead, k)).map(([k]) => k);
  const [open, setOpen] = useState(false), [fields, setFields] = useState<EnrichField[]>([]), [busy, setBusy] = useState(false), [msg, setMsg] = useState(""), [done, setDone] = useState<null | { got: EnrichField[]; missed: EnrichField[] }>(null);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [open]);
  async function run() {
    setBusy(true); setMsg("");
    try {
      const { results: [r] } = await api<{ results: { found: Found; missed: EnrichField[]; error?: string }[] }>("/api/leads/enrich", { body: { t: slug, ids: [lead.id], fields, again: true } });
      if (!r) setMsg("Lead nicht gefunden");
      else if (r.error) setMsg(r.error);
      else {
        if (Object.keys(r.found).length) onFound(r.found);
        setDone({ got: fields.filter(f => !r.missed.includes(f) && (f === "person" ? r.found.last : r.found[f as keyof Found])), missed: r.missed });
      }
    } catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  }
  return <span className="enr-at" ref={ref}>
    <button className="btn sec" onClick={() => { setOpen(!open); setFields(empty.filter(k => !miss[k])); setMsg(""); setDone(null); }} aria-expanded={open}><Icon n="sparkles" />Anreichern</button>
    {open && <div className="pop enr-pop" role="dialog" aria-label="Anreichern">
      {done ? <>
        {done.got.map(k => <div key={k} className="enr-hit"><Icon n="check" />{ENRICH.find(([f]) => f === k)?.[1]}</div>)}
        {done.missed.map(k => <div key={k} className="enr-miss"><Icon n="x" />{ENRICH.find(([f]) => f === k)?.[1]} nicht gefunden</div>)}
        <button className="btn sec wide" onClick={() => setOpen(false)}>Fertig</button>
      </> : <>
      {ENRICH.map(([k, l]) => { const has = !empty.includes(k);
        return <label key={k} className={`ck${has ? " f3" : ""}`} title={has ? "Schon ausgefüllt" : miss[k] ? `Websuche am ${new Date(miss[k]!).toLocaleDateString("de-DE")} ohne Treffer` : undefined}>
          <input type="checkbox" disabled={has || busy} checked={fields.includes(k)} onChange={() => setFields(fields.includes(k) ? fields.filter(f => f !== k) : [...fields, k])} />{l}{!has && miss[k] && <span className="f3">ohne Treffer</span>}</label>; })}
      {msg && <div className="f3">{msg}</div>}
      <button className="btn pri wide" onClick={run} disabled={busy || !fields.length}>{busy && <Icon n="loader" />}Im Web suchen</button>
      </>}
    </div>}
  </span>;
}

function Activity({ id }: { id: number }) {
  const [items, setItems] = useState<Act[] | null>(null), [err, setErr] = useState(""), [open, setOpen] = useState<number | null>(null);
  useEffect(() => { api<{ items: Act[] }>(`/api/leads/${id}`).then(r => setItems(r.items)).catch(e => setErr((e as Error).message)); }, [id]);
  if (err) return <div className="warn"><Icon n="triangle-alert" />{err}</div>;
  if (!items) return <div className="f3"><Icon n="loader" /></div>;
  return <ol className="acts">{items.map((a, i) => <li key={i} className={`k-${a.kind}`}>
    <span className="ai"><Icon n={ACT_ICON[a.kind] || "dot"} /></span>
    <div className="ab">
      <div className="at"><span className="tt">{a.title}</span><time className="f3">{when(a.at)}</time></div>
      {a.by && <div className="f3">{a.by}</div>}
      {a.text && <button className={`ax${open === i ? " on" : ""}`} onClick={() => setOpen(open === i ? null : i)}>{a.text}</button>}
    </div>
  </li>)}</ol>;
}

/* Edit one contact, or add a new one: person left, what happened in the middle, company right */
type Rated = { rating: number | null; vote: number; ratingInfo: { grade: string; reasons: { pts: number; text: string; learned?: boolean }[] } | null };

export function LeadDialog({ lead: lead0, slug, tenders, co, contacts = [], rating, miss, onVote, onClose, onSaved, onDeleted, onTrash, onAdd, onOpen, onEnriched }: {
  lead: EditLead; slug: string; tenders: boolean; co?: Co; contacts?: Mate[]; rating?: Rated; miss?: Partial<Record<EnrichField, string>>; onVote?: (v: number) => void; onClose: () => void; onSaved: (l: EditLead) => void; onDeleted?: (id: number) => void; onTrash?: () => void; onAdd?: (company: string) => void; onOpen?: (id: number) => void;
  onEnriched?: (id: number, found: Found) => void;
}) {
  /* what is saved; a search writes to it, so its finds do not count as unsaved changes */
  const [lead, setLead] = useState(lead0);
  const [f, setF] = useState(lead), [tt, setTt] = useState(tendersText(lead.tenders)), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const set = (k: keyof EditLead) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const ref = useDialog(onClose);
  contacts = contacts.filter(c => c.status !== "papierkorb");
  const addrs = addrsOf(contacts), m = co && contacts.length > 1 && addrs.length ? modeOf(co, contacts) : null;
  const mode0 = m ? (m.mode === "eine" ? `eine:${m.to[0] || ""}` : m.mode) : "", [mode, setMode] = useState(mode0);
  const mates = contacts.filter(c => c.id && c.id !== f.id);
  const dirty = JSON.stringify(f) !== JSON.stringify(lead) || tt !== tendersText(lead.tenders) || mode !== mode0;

  async function save() {
    setBusy(true); setErr("");
    const next = { ...f, tenders: tendersOf(tt) };
    /* only what changed, so fields the caller did not load stay as they are */
    const body = Object.fromEntries(Object.entries(next).filter(([k, v]) => k !== "id" && k !== "source" && JSON.stringify(v) !== JSON.stringify(lead[k as keyof EditLead])));
    try {
      if (f.id) {
        if (Object.keys(body).length) await api(`/api/leads/${f.id}`, { method: "PATCH", body });
        if (co && mode !== mode0) { const [mo, email = ""] = mode.split(":"); await api(`/api/companies/${co.id}`, { method: "PATCH", body: { mode: mo, email } }); }
        onSaved(next);
      }
      else { const r = await api<{ id: number }>("/api/leads", { body: { t: slug, lead: next } }); onSaved({ ...next, id: r.id, status: "neu" }); }
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  async function del() {
    if (!f.id || !confirm(`${nameOf(f) || f.company} löschen?`)) return;
    try { await api(`/api/leads/${f.id}`, { method: "DELETE" }); onDeleted?.(f.id); } catch (e) { setErr((e as Error).message); }
  }
  const go = (id: number) => { if (!dirty || confirm("Änderungen verwerfen?")) onOpen?.(id); };
  const web = httpUrl(f.website.includes(".") && !/^https?:/i.test(f.website) ? `https://${f.website}` : f.website);

  return <div className="ov" onClick={e => e.target === e.currentTarget && onClose()}><div className={`dlg ${f.id ? "xl" : "lg2"}`} ref={ref} role="dialog" aria-modal="true" aria-label={f.id ? "Kontakt bearbeiten" : "Kontakt hinzufügen"}>
    <div className="dlg-h">{f.id ? nameOf(f) || f.company : "Kontakt hinzufügen"}<span className="dlg-ha">
      {f.id && <EnrichMenu lead={lead} slug={slug} miss={miss} onFound={found => {
        setLead(l => ({ ...l, ...found }));
        /* fields typed meanwhile stay */
        setF(x => ({ ...x, ...Object.fromEntries(Object.entries(found).filter(([k]) => !x[k as keyof EditLead] || x[k as keyof EditLead] === lead[k as keyof EditLead])) }));
        onEnriched?.(f.id!, found);
      }} />}
      <button className="btn gh ic" onClick={onClose} aria-label="Schließen"><Icon n="x" /></button></span></div>
    <div className="rec">
      <section className="props">
        <h3>Person</h3>
        <Prop l="Anrede"><select className="pv" value={f.salutation} onChange={set("salutation")}><option value="">–</option>{SALUTATIONS.map(s => <option key={s}>{s}</option>)}</select></Prop>
        <Prop l="Vorname"><input className="pv" value={f.first} placeholder="–" onChange={set("first")} /></Prop>
        <Prop l="Nachname"><input className="pv" value={f.last} placeholder="–" onChange={set("last")} /></Prop>
        <Prop l="Rolle"><input className="pv" value={f.role} placeholder="–" onChange={set("role")} /></Prop>
        <Prop l="E-Mail" link={f.email.includes("@") ? `mailto:${f.email}` : undefined}><input className="pv mono" value={f.email} placeholder="–" onChange={set("email")} /></Prop>
        <Prop l="Adresse"><select className="pv" value={f.emailType} onChange={set("emailType")}><option value="person">Persönlich</option><option value="info">Sammeladresse</option></select></Prop>
        <Prop l="Telefon" link={f.phone.trim() ? `tel:${f.phone.replace(/[^+\d]/g, "")}` : undefined}><input className="pv num" value={f.phone} placeholder="–" onChange={set("phone")} /></Prop>
        <Prop l="LinkedIn" link={httpUrl(f.linkedin) || undefined}><input className="pv" value={f.linkedin} placeholder="–" onChange={set("linkedin")} /></Prop>
        {f.id && <Prop l="Kanal"><select className="pv" value={f.channel || ""} onChange={set("channel")}>
          <option value="">Automatisch{f.channelRec && f.channelRec.ch !== "none" ? `: ${f.channelRec.ch === "mail" ? "E-Mail" : "LinkedIn"}` : ""}</option><option value="mail">E-Mail</option><option value="linkedin">LinkedIn</option></select></Prop>}
        <Prop l="Status"><select className="pv" value={f.status} onChange={set("status")} disabled={!f.id}>{Object.entries(STATUS).map(([k, [n]]) => <option key={k} value={k}>{n}</option>)}</select></Prop>
        {!tenders && <Prop l="Anlass"><textarea className="pv" rows={1} value={f.hook} placeholder="–" onChange={set("hook")} /></Prop>}
        <Prop l="Link zur Quelle" link={httpUrl(f.sourceUrl) || undefined}><input className="pv" value={f.sourceUrl} placeholder="https://" onChange={set("sourceUrl")} /></Prop>
        <Prop l="Notiz"><textarea className="pv" rows={1} value={f.note} placeholder="–" onChange={set("note")} /></Prop>
        {(f.id || f.research) && <Prop l="Original"><textarea className="pv f2" rows={1} value={f.research} placeholder="–" onChange={set("research")} /></Prop>}
      </section>
      {f.id && <section className="feed"><h3>Aktivitäten</h3><Activity id={f.id} /></section>}
      <section className="props">
        {rating?.ratingInfo && rating.rating !== null && <div className="rating">
          <h3>Bewertung</h3>
          <div className="gr"><RatingBar value={rating.rating} /><span className="num f3">{rating.rating} von 100</span>
            {onVote && <span className="votes">
              <button className={`btn gh ic${rating.vote > 0 ? " on" : ""}`} aria-pressed={rating.vote > 0} onClick={() => onVote(1)} aria-label="Guter Lead" title="Guter Lead"><Icon n="thumbs-up" /></button>
              <button className={`btn gh ic${rating.vote < 0 ? " on" : ""}`} aria-pressed={rating.vote < 0} onClick={() => onVote(-1)} aria-label="Schlechter Lead" title="Schlechter Lead"><Icon n="thumbs-down" /></button>
            </span>}
          </div>
        </div>}
        <h3 className={rating?.ratingInfo ? "h2" : undefined}>Unternehmen</h3>
        <Prop l="Firma"><input className="pv" value={f.company} placeholder="–" onChange={set("company")} /></Prop>
        <Prop l="Website" link={web || undefined}><input className="pv" value={f.website} placeholder="–" onChange={set("website")} /></Prop>
        <Prop l="Ort"><input className="pv" value={f.city} placeholder="–" onChange={set("city")} /></Prop>
        {m && <Prop l="Anschreiben"><select className="pv" value={mode} onChange={e => setMode(e.target.value)}>
          <option value="einzeln">Jede der {contacts.length} Personen einzeln</option>
          {addrs.length > 1 && <option value="alle">Eine Mail an alle Adressen</option>}
          {addrs.map(a => <option key={a} value={`eine:${a}`}>Eine Mail an {a}</option>)}
        </select></Prop>}
        {tenders && <Prop l="Ausschreibungen"><textarea className="pv" rows={1} value={tt} placeholder="Titel | Vergabestelle | Frist" onChange={e => setTt(e.target.value)} /></Prop>}
        {f.id && (mates.length > 0 || onAdd) && <>
          <h3 className="h2">Kontakte</h3>
          <ul className="mates">
            {mates.map(c => <li key={c.id}><button onClick={() => go(c.id!)} disabled={!onOpen}><span className="nm">{nameOf(c) || c.email || "–"}</span>{c.role && <span className="f3">{c.role}</span>}</button></li>)}
            {onAdd && <li><button className="f2" onClick={() => onAdd(f.company)}><Icon n="plus" />Weiterer Kontakt</button></li>}
          </ul>
        </>}
      </section>
    </div>
    {err && <div className="warn"><Icon n="triangle-alert" />{err}</div>}
    <div className="dlg-f">
      {f.id && onTrash && lead.status !== "papierkorb" ? <button className="btn gh" onClick={onTrash}><Icon n="trash-2" />Löschen</button>
        : f.id && onDeleted && <button className="btn gh" onClick={del}>Endgültig löschen</button>}
      <span className="sp" />
      <button className="btn sec" onClick={onClose}>Abbrechen</button>
      <button className="btn pri" onClick={save} disabled={busy || !f.company.trim()}>{busy && <Icon n="loader" />}Speichern</button>
    </div>
  </div></div>;
}
