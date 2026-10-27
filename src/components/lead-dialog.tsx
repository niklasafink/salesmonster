"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import type { EnrichField, Tender, Touch } from "@/db/schema";
import { addrsOf, modeOf } from "@/lib/company-mode";
import { SALUTATIONS, hasField, httpUrl } from "@/lib/lead-fields";
import { Icon, api, useDialog } from "./ui";

export type EditLead = {
  id?: number; company: string; salutation: string; first: string; last: string; role: string; email: string; emailType: string; phone: string;
  linkedin: string; website: string; city: string; hook: string; note: string; sourceUrl: string; research?: string; status: string; tenders: Tender[]; source?: string;
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
type Act = { at: string; kind: string; title: string; text?: string; by?: string; meta?: string; src?: string; co?: boolean };
type HsInfo = { url: string; coUrl: string; person: [string, string][]; company: [string, string][]; deals: { name: string; stage: string; amount: string; close: string; url: string }[] };
type Hist = { items: Act[]; research?: string; hs: HsInfo | null; hsError?: string };

const ACT_ICON: Record<string, string> = { crm: "user-check", sent: "send", reply: "mail", bounce: "triangle-alert", draft: "file-text", mailbox: "inbox", created: "plus", linkedin: "linkedin",
  note: "sticky-note", call: "phone", meeting: "calendar", "hs-in": "mail", "hs-out": "send", task: "list-todo" };
/* the filters over the history; a filter only shows when it has entries */
const ACT_TABS: [string, string, string[]][] = [["note", "Notizen", ["note"]], ["call", "Anrufe", ["call"]], ["meeting", "Meetings", ["meeting"]],
  ["mail", "E-Mails", ["hs-in", "hs-out", "sent", "reply", "bounce", "mailbox", "draft", "linkedin"]], ["task", "Aufgaben", ["task"]]];
const when = (iso: string) => new Date(iso).toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Berlin" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const month = (iso: string) => new Date(iso).toLocaleDateString("de-DE", { month: "long", year: "numeric", timeZone: "Europe/Berlin" });
const nameOf = (x: { first: string; last: string }) => [x.first, x.last].filter(Boolean).join(" ");
const lines = (rows: [string, string][]) => rows.filter(([, v]) => v.trim()).map(([l, v]) => `${l}: ${v}`).join("\n");

/* copies the text, the icon turns into a check for a moment */
function CopyBtn({ text, label }: { text: string; label: string }) {
  const [ok, setOk] = useState(false);
  return <button type="button" className="pc" title={`${label} kopieren`} aria-label={`${label} kopieren`}
    onClick={() => navigator.clipboard.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); }).catch(() => {})}><Icon n={ok ? "check" : "copy"} /></button>;
}

/* label left, value right; the input only shows as one on hover and focus, copy and link show on hover */
const Prop = ({ l, link, copy, children }: { l: string; link?: string; copy?: string; children: React.ReactNode }) => <div className="prop">
  <label><span className="pk">{l}</span>{children}</label>
  {copy?.trim() && <CopyBtn text={copy.trim()} label={l} />}
  {link && <a className="pa" href={link} target={link.startsWith("http") ? "_blank" : undefined} rel="noreferrer" aria-label={`${l} öffnen`}><Icon n="external-link" /></a>}
</div>;

/* a titled block of fields; the title copies all of them at once */
const Group = ({ t, copy, link, children }: { t: string; copy?: string; link?: string; children: React.ReactNode }) => <div className="grp">
  <h3><span>{t}</span>{link && <a className="pa" href={link} target="_blank" rel="noreferrer" aria-label={`${t} öffnen`} title="In HubSpot öffnen"><Icon n="external-link" /></a>}
    {copy?.trim() && <CopyBtn text={copy} label={t} />}</h3>
  {children}
</div>;

/* read-only value from HubSpot */
const Ro = ({ l, v }: { l: string; v: string }) => <Prop l={l} copy={v}><span className="pv ro">{v}</span></Prop>;

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

/* the history and the HubSpot record of one saved contact, loaded once when the dialog opens */
function useHistory(id: number | undefined, onResearch?: (text: string) => void) {
  const [h, setH] = useState<Hist | null>(null), [err, setErr] = useState("");
  const got = useRef(onResearch); got.current = onResearch;
  useEffect(() => { if (id) api<Hist>(`/api/leads/${id}`).then(r => { setH(r); got.current?.(r.research ?? ""); }).catch(e => setErr((e as Error).message)); }, [id]);
  return { h, err };
}

/* long texts start shortened; a click shows all of it */
const LONG = 320;

/* everything that happened, newest first, by month; planned entries (future dates) on top, marked */
function History({ h, err }: { h: Hist | null; err: string }) {
  const [tab, setTab] = useState(""), [open, setOpen] = useState<Set<number>>(new Set());
  if (err) return <div className="warn"><Icon n="triangle-alert" />{err}</div>;
  if (!h) return <div className="f3 hload"><Icon n="loader" />Verlauf und HubSpot werden geladen</div>;
  const kinds = ACT_TABS.find(([k]) => k === tab)?.[2], items = h.items.filter(a => !kinds || kinds.includes(a.kind));
  const now = new Date().toISOString();
  let last = "";
  return <>
    <div className="htabs" role="tablist">
      <button role="tab" aria-selected={!tab} className={!tab ? "on" : ""} onClick={() => setTab("")}>Alle<span className="num">{h.items.length}</span></button>
      {ACT_TABS.map(([k, l, ks]) => { const n = h.items.filter(a => ks.includes(a.kind)).length;
        return n > 0 && <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}<span className="num">{n}</span></button>; })}
    </div>
    {h.hsError && <div className="warn"><Icon n="triangle-alert" />HubSpot: {h.hsError}</div>}
    {!items.length ? <p className="f3">Noch nichts.</p> : <ol className="acts">{items.map((a, i) => {
      const fut = a.at > now, m = fut ? "Geplant" : month(a.at), head = m !== last ? (last = m) : "";
      const long = (a.text?.length ?? 0) > LONG || (a.text?.split("\n").length ?? 0) > 6, on = open.has(i);
      return <Fragment key={i}>{head && <li className="mon">{head}</li>}<li className={`k-${a.kind}${fut ? " fut" : ""}`}>
        <span className="ai"><Icon n={ACT_ICON[a.kind] || "dot"} /></span>
        <div className="ab">
          <div className="at"><span className="tt">{a.title}</span><time className="f3" dateTime={a.at} title={`${when(a.at)}, ${clock(a.at)} Uhr`}>{when(a.at)}</time></div>
          {(a.meta || a.by || a.src) && <div className="am f3">
            {[a.meta, a.by].filter(Boolean).join(" · ")}
            {a.src && <span className="tag">{a.src}</span>}{a.co && <span className="tag" title="In HubSpot an der Firma, nicht an der Person erfasst">Firma</span>}
          </div>}
          {a.text && <div className={`ax${long && !on ? " cut" : ""}`}>{a.text}</div>}
          {long && <button className="more-t" onClick={() => setOpen(s => { const n = new Set(s); if (on) n.delete(i); else n.add(i); return n; })}>{on ? "Weniger" : "Alles anzeigen"}</button>}
        </div>
      </li></Fragment>; })}</ol>}
  </>;
}

/* Edit one contact, or add a new one: person left, note and history in the middle, company right */
type Rated = { rating: number | null; vote: number; touch?: Touch | null; ratingInfo: { grade: string; reasons: { pts: number; text: string; learned?: boolean }[]; type?: string; why?: string } | null };

/* individual contact as Jev read it from the HubSpot activities */
export const TOUCHES = [["demo", "Demo", "presentation"], ["call", "Telefonat", "phone"], ["mail", "E-Mail", "mail"]] as const;
const touchText = (t: Touch) => [TOUCHES.filter(([k]) => t[k]).map(([, l]) => l).join(", ") || "Noch kein persönlicher Kontakt",
  t.box && (t.box.sent || t.box.direct) ? `Postfach: ${t.box.sent} gesendet, ${t.box.direct} direkt erhalten` : ""].filter(Boolean).join(" · ");

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
  /* the list does not carry the research text; it arrives with the history and counts as saved */
  const { h, err: herr } = useHistory(f.id, lead0.research === undefined ? research => {
    setLead(l => ({ ...l, research })); setF(x => x.research === undefined ? { ...x, research } : x);
  } : undefined), hs = h?.hs;
  /* the whole contact as one block of text */
  const card = lines([["Name", [f.salutation, f.first, f.last].filter(Boolean).join(" ")], ["Rolle", f.role], ["Firma", f.company], ["E-Mail", f.email], ["Telefon", f.phone], ["LinkedIn", f.linkedin], ["Website", f.website], ["Ort", f.city]]);
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
      <section className="props side">
        <Group t="Person" copy={card}>
          <Prop l="Name" copy={[f.salutation, f.first, f.last].filter(Boolean).join(" ")}><span className="pv3">
            <select className="pv sal" value={f.salutation} onChange={set("salutation")} aria-label="Anrede"><option value="">–</option>{SALUTATIONS.map(s => <option key={s}>{s}</option>)}</select>
            <input className="pv" value={f.first} placeholder="Vorname" aria-label="Vorname" onChange={set("first")} />
            <input className="pv" value={f.last} placeholder="Nachname" aria-label="Nachname" onChange={set("last")} /></span></Prop>
          <Prop l="Rolle" copy={f.role}><input className="pv" value={f.role} placeholder="–" onChange={set("role")} /></Prop>
        </Group>
        <Group t="Kontaktdaten" copy={lines([["E-Mail", f.email], ["Telefon", f.phone], ["LinkedIn", f.linkedin]])}>
          <Prop l="E-Mail" copy={f.email} link={f.email.includes("@") ? `mailto:${f.email}` : undefined}><input className="pv mono" value={f.email} placeholder="–" onChange={set("email")} /></Prop>
          <Prop l="Adresse"><select className="pv" value={f.emailType} onChange={set("emailType")}><option value="person">Persönlich</option><option value="info">Sammeladresse</option></select></Prop>
          <Prop l="Telefon" copy={f.phone} link={f.phone.trim() ? `tel:${f.phone.replace(/[^+\d]/g, "")}` : undefined}><input className="pv num" value={f.phone} placeholder="–" onChange={set("phone")} /></Prop>
          <Prop l="LinkedIn" copy={f.linkedin} link={httpUrl(f.linkedin) || undefined}><input className="pv" value={f.linkedin} placeholder="–" onChange={set("linkedin")} /></Prop>
        </Group>
        <Group t="Vertrieb">
          <Prop l="Status" copy={STATUS[f.status]?.[0]}><select className="pv" value={f.status} onChange={set("status")} disabled={!f.id}>{Object.entries(STATUS).map(([k, [n]]) => <option key={k} value={k}>{n}</option>)}</select></Prop>
          {f.id && <Prop l="Kanal"><select className="pv" value={f.channel || ""} onChange={set("channel")}>
            <option value="">Automatisch{f.channelRec && f.channelRec.ch !== "none" ? `: ${f.channelRec.ch === "mail" ? "E-Mail" : "LinkedIn"}` : ""}</option><option value="mail">E-Mail</option><option value="linkedin">LinkedIn</option></select></Prop>}
          {!tenders && <Prop l="Anlass" copy={f.hook}><textarea className="pv" rows={1} value={f.hook} placeholder="–" onChange={set("hook")} /></Prop>}
        </Group>
        <Group t="Quelle">
          <Prop l="Link" copy={f.sourceUrl} link={httpUrl(f.sourceUrl) || undefined}><input className="pv" value={f.sourceUrl} placeholder="https://" onChange={set("sourceUrl")} /></Prop>
          {(f.id || f.research) && <Prop l="Original" copy={f.research}><textarea className="pv f2" rows={1} value={f.research ?? ""} placeholder="–" onChange={set("research")} /></Prop>}
          {!f.id && <Prop l="Notiz" copy={f.note}><textarea className="pv" rows={1} value={f.note} placeholder="–" onChange={set("note")} /></Prop>}
        </Group>
        {!!hs?.person.length && <Group t="HubSpot" link={hs.url || undefined} copy={lines(hs.person)}>{hs.person.map(([l, v]) => <Ro key={l} l={l} v={v} />)}</Group>}
      </section>
      {f.id && <section className="feed">
        <div className="note-card">
          <label htmlFor="lead-note"><Icon n="sticky-note" />Notiz{f.note.trim() && <CopyBtn text={f.note.trim()} label="Notiz" />}</label>
          <textarea id="lead-note" rows={2} value={f.note} placeholder="Was man über diesen Kontakt wissen sollte" onChange={set("note")} />
        </div>
        <h3>Verlauf</h3>
        <History h={h} err={herr} />
      </section>}
      <section className="props side">
        {rating?.ratingInfo && rating.rating !== null && <div className="rating grp">
          <h3><span>Bewertung</span></h3>
          <div className="gr"><RatingBar value={rating.rating} /><span className="num f3">{rating.rating} von 100</span>
            {onVote && <span className="votes">
              <button className={`btn gh ic${rating.vote > 0 ? " on" : ""}`} aria-pressed={rating.vote > 0} onClick={() => onVote(1)} aria-label="Guter Lead" title="Guter Lead"><Icon n="thumbs-up" /></button>
              <button className={`btn gh ic${rating.vote < 0 ? " on" : ""}`} aria-pressed={rating.vote < 0} onClick={() => onVote(-1)} aria-label="Schlechter Lead" title="Schlechter Lead"><Icon n="thumbs-down" /></button>
            </span>}
          </div>
          {(rating.ratingInfo.type || rating.ratingInfo.why) && <p className="why f2">{[rating.ratingInfo.type && `Note ${rating.ratingInfo.grade}, ${rating.ratingInfo.type}`, rating.ratingInfo.why].filter(Boolean).join(": ")}</p>}
          <ul className="rsn">{rating.ratingInfo.reasons.slice(0, 6).map((r, i) => <li key={i}><span className={`num ${r.pts > 0 ? "up" : "down"}`}>{r.pts > 0 ? "+" : "−"}{Math.abs(r.pts)}</span>{r.text}</li>)}</ul>
          {rating.touch && <p className="f2 tch" title={rating.touch.last ? `Letzte Aktivität ${new Date(rating.touch.last).toLocaleDateString("de-DE")}` : undefined}>
            {TOUCHES.filter(([k]) => rating.touch![k]).map(([k, , ic]) => <Icon key={k} n={ic} />)}{touchText(rating.touch)}</p>}
        </div>}
        <Group t="Unternehmen" link={hs?.coUrl || undefined} copy={lines([["Firma", f.company], ["Website", f.website], ["Ort", f.city], ...(hs?.company || [])])}>
          <Prop l="Firma" copy={f.company}><input className="pv" value={f.company} placeholder="–" onChange={set("company")} /></Prop>
          <Prop l="Website" copy={f.website} link={web || undefined}><input className="pv" value={f.website} placeholder="–" onChange={set("website")} /></Prop>
          <Prop l="Ort" copy={f.city}><input className="pv" value={f.city} placeholder="–" onChange={set("city")} /></Prop>
          {m && <Prop l="Anschreiben"><select className="pv" value={mode} onChange={e => setMode(e.target.value)}>
            <option value="einzeln">Jede der {contacts.length} Personen einzeln</option>
            {addrs.length > 1 && <option value="alle">Eine Mail an alle Adressen</option>}
            {addrs.map(a => <option key={a} value={`eine:${a}`}>Eine Mail an {a}</option>)}
          </select></Prop>}
          {tenders && <Prop l="Ausschreibungen"><textarea className="pv" rows={1} value={tt} placeholder="Titel | Vergabestelle | Frist" onChange={e => setTt(e.target.value)} /></Prop>}
          {hs?.company.filter(([l]) => l !== "Ort" || !f.city.trim()).map(([l, v]) => <Ro key={l} l={l} v={v} />)}
        </Group>
        {!!hs?.deals.length && <Group t="Deals" copy={hs.deals.map(d => [d.name, d.stage, d.amount, d.close && `Abschluss ${d.close}`].filter(Boolean).join(" · ")).join("\n")}>
          <ul className="deals">{hs.deals.map((d, i) => <li key={i}><a href={d.url} target="_blank" rel="noreferrer"><span className="nm">{d.name}</span>{d.amount && <span className="num">{d.amount}</span>}</a>
            <div className="f3">{[d.stage, d.close && `Abschluss ${d.close}`].filter(Boolean).join(" · ")}</div></li>)}</ul>
        </Group>}
        {f.id && (mates.length > 0 || onAdd) && <Group t="Kontakte">
          <ul className="mates">
            {mates.map(c => <li key={c.id}><button onClick={() => go(c.id!)} disabled={!onOpen}><span className="nm">{nameOf(c) || c.email || "–"}</span>{c.role && <span className="f3">{c.role}</span>}</button></li>)}
            {onAdd && <li><button className="f2" onClick={() => onAdd(f.company)}><Icon n="plus" />Weiterer Kontakt</button></li>}
          </ul>
        </Group>}
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
