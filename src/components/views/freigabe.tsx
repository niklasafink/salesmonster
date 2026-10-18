"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fill } from "@/lib/fill";
import { httpUrl } from "@/lib/lead-fields";
import { Icon, Top, api, useAutosize } from "../ui";
import type { Ctx, Draft, DraftScore, State, Tpl } from "../types";
import { LeadDialog, emptyLead, type EditLead } from "../lead-dialog";

const ST: Record<string, [string, string]> = { entwurf: ["Entwurf", ""], freigegeben: ["Freigegeben", "g"], uebersprungen: ["Übersprungen", ""] };

/* colour band of a 0–100 score */
export const grade = (n: number) => n >= 70 ? "hi" : n >= 50 ? "mid" : "lo";

export function msgOf(d: Draft, tpls: Tpl[], sender: string) {
  const t = tpls.find(x => x.key === d.variant) || tpls[0];
  if (!t) return { subject: d.subject || "", body: d.body || "" };
  const l = { ...d.lead, people: d.people };
  return { subject: d.subject ?? fill(t.subject, l, t, sender), body: d.body ?? fill(t.body, l, t, sender) };
}

export async function approveAllDrafts(st: State) {
  const items = st.drafts.filter(d => d.status === "entwurf").map(d => { const m = msgOf(d, st.templates, st.me.name); return { id: d.id, finalSubject: m.subject, finalBody: m.body }; });
  if (items.length) await api("/api/messages/approve-all", { body: { items } });
  return items.length;
}

/* Next weekday 08:00 in Berlin */
function nextSend() {
  const now = new Date(), fmt = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", ...o }).format(d);
  const hour = Number(fmt(now, { hour: "2-digit", hour12: false }));
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getTime() + i * 864e5), wd = fmt(d, { weekday: "short" });
    if (/Sa|So/.test(wd) || (i === 0 && hour >= 8)) continue;
    return { short: `${wd.replace(".", "")} 08:00`, long: i === 0 ? "heute um 08:00" : i === 1 ? "morgen um 08:00" : `am ${fmt(d, { weekday: "long" })} um 08:00` };
  }
  return { short: "08:00", long: "um 08:00" };
}

export function Freigabe({ ctx, focus, onFocused }: { ctx: Ctx; focus: number | null; onFocused: () => void }) {
  const { st, toast, reload } = ctx;
  const [L, setL] = useState<Draft[]>(st.drafts);
  const [edit, setEdit] = useState<EditLead | null>(null);
  const [sel, setSel] = useState(0), [det, setDet] = useState(false), [done, setDone] = useState(false), [busy, setBusy] = useState(false), [better, setBetter] = useState<number | null>(null);
  const fit = useAutosize(), bodyRef = useRef<HTMLTextAreaElement>(null);
  const timers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  useEffect(() => { setL(st.drafts); }, [st.drafts]);
  useEffect(() => { if (focus != null) { const i = L.findIndex(d => d.id === focus); if (i >= 0) { setSel(i); setDet(true); setDone(false); } onFocused(); } }, [focus, L, onFocused]);

  const t = st.tenant!, tpls = st.templates, sender = st.me.name, send = useMemo(nextSend, []);
  const appr = L.filter(l => l.status === "freigegeben").length, open = L.filter(l => l.status === "entwurf").length;
  const cur = L[Math.min(sel, L.length - 1)];

  const patch = (id: number, p: Partial<Draft>) => setL(ls => ls.map(d => d.id === id ? { ...d, ...p } : d));
  const save = (id: number, body: object, delay = 0) => {
    clearTimeout(timers.current[id]);
    timers.current[id] = setTimeout(() => api(`/api/messages/${id}`, { method: "PATCH", body }).catch(e => toast(e.message, { error: true })), delay);
  };
  /* score of the text as shown; edits are scored again once typing stops */
  const scoring = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const rescore = useCallback((id: number, text: { subject: string; body: string } | null, delay = 0) => {
    clearTimeout(scoring.current[id]);
    scoring.current[id] = setTimeout(() => api<DraftScore>(`/api/messages/${id}/score`, { body: text || {} })
      .then(score => setL(ls => ls.map(d => d.id === id ? { ...d, score } : d))).catch(() => {}), delay);
  }, []);
  const nextOpen = useCallback((from: number, list: Draft[]) => { for (let j = 1; j <= list.length; j++) { const k = (from + j) % list.length; if (list[k].status === "entwurf") return k; } return -1; }, []);

  const approve = useCallback(async (i: number) => {
    const d = L[i]; if (!d) return;
    const m = msgOf(d, tpls, sender);
    const next = L.map((x, k) => k === i ? { ...x, status: "freigegeben" } : x);
    setL(next);
    const n = nextOpen(i, next); if (n >= 0) setSel(n); else setDone(true);
    toast(`${d.lead.company} freigegeben`);
    try { await api(`/api/messages/${d.id}`, { method: "PATCH", body: { action: "approve", finalSubject: m.subject, finalBody: m.body } }); } catch (e) { toast((e as Error).message, { error: true }); }
  }, [L, tpls, sender, toast, nextOpen]);

  const skip = useCallback(async (i: number) => {
    const d = L[i]; if (!d) return;
    const back = d.status === "uebersprungen";
    const next = L.map((x, k) => k === i ? { ...x, status: back ? "entwurf" : "uebersprungen" } : x);
    setL(next);
    if (!back) { const n = nextOpen(i, next); if (n >= 0) setSel(n); else setDone(true); }
    toast(`${d.lead.company} ${back ? "wieder aufgenommen" : "übersprungen"}`);
    try { await api(`/api/messages/${d.id}`, { method: "PATCH", body: { action: "skip" } }); } catch (e) { toast((e as Error).message, { error: true }); }
  }, [L, toast, nextOpen]);

  async function approveAll() {
    try { const n = await approveAllDrafts({ ...st, drafts: L }); setL(ls => ls.map(d => d.status === "entwurf" ? { ...d, status: "freigegeben" } : d)); setDone(true); toast(n ? `${n} Nachrichten freigegeben` : "Alles ist schon freigegeben"); reload(); }
    catch (e) { toast((e as Error).message, { error: true }); }
  }

  /* Grok rewrites, Jev decides; the text only changes when the new one scores clearly higher */
  async function improve(d: Draft) {
    const m = msgOf(d, tpls, sender), before = d.score?.total;
    /* a pending autosave would overwrite the rewrite; when nothing better comes back, the user's text is saved right away instead */
    const edited = d.subject !== null || d.body !== null;
    clearTimeout(timers.current[d.id]); clearTimeout(scoring.current[d.id]);
    setBetter(d.id);
    try {
      const r = await api<{ improved: boolean; subject?: string; body?: string; score: DraftScore }>(`/api/messages/${d.id}/improve`, { body: m });
      if (r.improved) { patch(d.id, { subject: r.subject!, body: r.body!, score: r.score, improved: true }); toast(`Verbessert, Score ${before ?? "–"} → ${r.score.total}`); }
      else { if (edited) save(d.id, m); patch(d.id, { score: r.score }); toast("Keine bessere Fassung gefunden"); }
    } catch (e) { toast((e as Error).message, { error: true }); }
    setBetter(null);
  }

  async function research() {
    setBusy(true);
    try { const r = await api<{ created: number }>("/api/run", { body: { t: t.slug, job: "research" } }); await reload(); toast(r.created ? `${r.created} Entwürfe erstellt` : "Keine neuen Leads gefunden"); }
    catch (e) { toast((e as Error).message, { error: true }); }
    setBusy(false);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.matches("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey || document.querySelector(".ov") || !L.length) return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setSel(s => (s + 1) % L.length); setDone(false); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setSel(s => (s - 1 + L.length) % L.length); setDone(false); }
      else if (e.key === "a" && !done) approve(sel);
      else if (e.key === "s" && !done) skip(sel);
      else if (e.key === "e" && bodyRef.current) { e.preventDefault(); bodyRef.current.focus(); }
    };
    addEventListener("keydown", onKey); return () => removeEventListener("keydown", onKey);
  }, [L, sel, done, approve, skip]);

  useEffect(() => { document.querySelector(".li.on")?.scrollIntoView({ block: "nearest" }); fit(bodyRef.current); });
  const curId = L[Math.min(sel, L.length - 1)]?.id, jev = !!st.integ.openrouter?.on;
  useEffect(() => { const d = L.find(x => x.id === curId); if (jev && d && !d.score && d.status === "entwurf") rescore(d.id, null); }, [curId, jev]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!L.length) return <>
    <Top title="Freigabe" onMenu={ctx.openSidebar} />
    <div className="empty"><div>
      <div className="h2">Keine Entwürfe</div>
      <button className="btn pri" onClick={research} disabled={busy}>{busy && <Icon n="loader" />}{busy ? "Recherche läuft" : "Jetzt recherchieren"}</button>
    </div></div>
  </>;

  const from = st.mailbox[st.me.id];
  const d = cur, m = msgOf(d, tpls, sender), ch = d.channel || "mail", edited = d.subject !== null || d.body !== null;
  /* the template asks for something this lead does not have */
  const tplNow = tpls.find(x => x.key === d.variant), uses = (p: string) => !!tplNow && (tplNow.subject + tplNow.body).includes(p);
  const gap = d.subject === null && d.body === null && (uses("{{aufhaenger}}") && !d.lead.hook ? "Anlass fehlt, der Satz mit {{aufhaenger}} bleibt leer."
    : uses("{{ausschreibungen}}") && !d.lead.tenders.length ? "Keine Ausschreibungen, {{ausschreibungen}} bleibt leer." : "");
  const openLead = () => setEdit({ ...emptyLead(), ...d.lead, status: "freigabe" });
  const onLeadSaved = (l: EditLead) => {
    setEdit(null);
    const lead = { ...d.lead, ...Object.fromEntries(Object.keys(d.lead).map(k => [k, (l as Record<string, unknown>)[k] ?? (d.lead as Record<string, unknown>)[k]])) } as Draft["lead"];
    patch(d.id, { lead, people: d.people.length > 1 ? d.people : [{ first: lead.first, last: lead.last, salutation: lead.salutation, role: lead.role, email: lead.email }], to: d.people.length > 1 ? d.to : lead.email });
    toast("Gespeichert");
  };

  return <>
    <Top title="Freigabe" onMenu={ctx.openSidebar}>
      <button className="btn sec" onClick={approveAll} disabled={!open}><Icon n="check-check" />Alle freigeben{open ? ` (${open})` : ""}</button>
    </Top>
    <div className={`review ${det ? "det" : ""}`}>
      <div className="list">
        {L.map((x, i) => <button key={x.id} className={`li ${i === sel && !done ? "on" : ""} ${x.status === "uebersprungen" ? "skip" : ""}`} onClick={() => { setSel(i); setDet(true); setDone(false); }}>
          <div className="m"><div className="t">{x.lead.company}</div></div>{x.status === "freigegeben" && <Icon n="check" className="ok" />}
        </button>)}
      </div>
      {done ? <div className="detail"><div className="done"><div className="h2">{appr} Nachrichten gehen {send.long} raus</div></div></div> :
      <div className="detail">
        <div className="d-head">
          <button className="btn gh ic mob" onClick={() => setDet(false)} aria-label="Zurück"><Icon n="arrow-left" /></button>
          <div className="n" style={{ minWidth: 0 }}>{d.lead.company}</div>
          <div className="nav2"><span className="num hide-m">{sel + 1} / {L.length}</span>
            <button className="btn gh ic" onClick={() => setSel((sel - 1 + L.length) % L.length)} aria-label="Vorheriger Lead"><Icon n="chevron-up" /></button>
            <button className="btn gh ic" onClick={() => setSel((sel + 1) % L.length)} aria-label="Nächster Lead"><Icon n="chevron-down" /></button></div>
        </div>
        <div className="d-body">
          <div className="compose">
            <div className="abbar">
              <div className="seg">{tpls.filter(x => x.active || x.key === d.variant).map(x => <button key={x.key} className={d.variant === x.key ? "on" : ""}
                onClick={() => { patch(d.id, { variant: x.key, subject: null, body: null, improved: false }); save(d.id, { variant: x.key }); if (jev) rescore(d.id, null, 700); }}>{x.name}</button>)}</div>
              <span style={{ flex: 1 }} />
              <div className="seg">
                <button className={ch === "mail" ? "on" : ""} onClick={() => { patch(d.id, { channel: "mail" }); save(d.id, { channel: "mail" }); }}><Icon n="mail" />E-Mail</button>
                <button className={ch === "linkedin" ? "on" : ""} onClick={() => { patch(d.id, { channel: "linkedin" }); save(d.id, { channel: "linkedin" }); }}><Icon n="linkedin" />LinkedIn</button>
              </div>
            </div>
            {ch === "linkedin" && <div className="warn"><Icon n="triangle-alert" />SendPilot ist noch nicht verbunden. Die Nachricht wird erst verschickt, wenn die Verbindung steht.</div>}
            {ch === "mail" && !from && <div className="warn"><Icon n="triangle-alert" />Für dich ist kein Postfach verbunden. Ohne Postfach bleibt die Nachricht nach der Freigabe liegen.</div>}
            {d.error && <div className="warn"><Icon n="triangle-alert" />{d.error}</div>}
            {gap && <div className="warn"><Icon n="triangle-alert" />{gap}<button className="btn gh" style={{ marginLeft: "auto" }} onClick={openLead}>Ergänzen</button></div>}
            <div className="doc">
              <div className="doc-meta"><span>An</span><span className="mono">{ch === "mail" ? d.to || "Keine Adresse" : d.lead.linkedin || (d.lead.last ? `${d.lead.first} ${d.lead.last} (LinkedIn)` : "Kein LinkedIn-Profil gefunden")}</span>
                <span>Von</span><span className="mono">{from || "–"}</span></div>
              {ch === "mail" && <input className="subj" value={m.subject} aria-label="Betreff" onChange={e => { patch(d.id, { subject: e.target.value, body: d.body ?? m.body }); save(d.id, { subject: e.target.value, body: d.body ?? m.body }, 600); if (jev) rescore(d.id, { subject: e.target.value, body: m.body }, 1500); }} />}
              <textarea ref={bodyRef} className="body" value={m.body} aria-label="Nachricht" onChange={e => { fit(e.target); patch(d.id, { body: e.target.value, subject: d.subject ?? m.subject }); save(d.id, { body: e.target.value, subject: d.subject ?? m.subject }, 600); if (jev) rescore(d.id, { subject: m.subject, body: e.target.value }, 1500); }} />
            </div>
          </div>
          <div className="props">
            {d.score && <div className="prop"><div className="l">Score</div><div className="v"><span className={`score ${grade(d.score.total)}`}>{d.score.total}</span></div></div>}
            {d.score?.expected !== undefined && <div className="prop"><div className="l">Erwartete Antwort</div><div className="v">{Math.round(d.score.expected * 1000) / 10} %</div></div>}
            {!!d.score?.issues.length && <div className="prop"><div className="l">Schwächen</div><div className="v">{d.score.issues.map(i => <div key={i}>{i}</div>)}</div></div>}
            <div className="prop"><div className="l">Status</div><div className="v"><span className={`pill ${ST[d.status]?.[1] || ""}`}>{ST[d.status]?.[0]}</span></div></div>
            <div className="prop"><div className="l">{d.people.length > 1 ? "Kontakte" : "Kontakt"}</div><div className="v">{d.people.length > 1 ? d.people.filter(p => p.last).map((p, k) => <div key={k}>{`${p.first} ${p.last}${p.role ? `, ${p.role}` : ""}`}</div>)
              : <button className="lnk" onClick={openLead}>{d.lead.last ? `${[d.lead.salutation, d.lead.first, d.lead.last].filter(Boolean).join(" ")}${d.lead.role ? `, ${d.lead.role}` : ""}` : "Kein Name gefunden"}</button>}</div></div>
            {d.lead.city && <div className="prop"><div className="l">Ort</div><div className="v">{d.lead.city}</div></div>}
            <div className="prop"><div className="l">Quelle</div><div className="v">{httpUrl(d.lead.sourceUrl) ? <a href={httpUrl(d.lead.sourceUrl)} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>{d.lead.source}</a> : d.lead.source}</div></div>
            <div className="prop"><div className="l">E-Mail</div><div className="v"><span className="mono" style={{ overflowWrap: "anywhere" }}>{d.to || "–"}</span>{d.lead.emailType === "info" && <span className="pill a">Sammeladresse</span>}</div></div>
            {httpUrl(d.lead.website) && <div className="prop"><div className="l">Website</div><div className="v"><a className="mono" style={{ overflowWrap: "anywhere", color: "inherit" }} href={httpUrl(d.lead.website)} target="_blank" rel="noreferrer">{d.lead.website.replace(/^https?:\/\/(www\.)?/, "")}</a></div></div>}
            {t.tenders ? <div className="prop"><div className="l">Ausschreibungen</div><div className="v">{d.lead.tenders.length ? d.lead.tenders.map((x, k) => <div className="tender" key={k}><span><span className="t">{x.t}</span> <span className="s">({x.s}{x.f ? `, Frist ${x.f}` : ""})</span></span></div>) : "Keine gefunden"}</div></div>
              : <div className="prop"><div className="l">Anlass</div><div className="v">{d.lead.hook || "–"}</div></div>}
          </div>
        </div>
        <div className="actions">
          {edited && <button className="btn gh" onClick={() => { patch(d.id, { subject: null, body: null, improved: false }); save(d.id, { action: "reset" }); if (jev) rescore(d.id, null, 700); toast("Text auf Vorlage zurückgesetzt"); }}>Änderungen verwerfen</button>}
          <span className="sp" />
          {ch === "mail" && jev && <button className="btn sec" onClick={() => improve(d)} disabled={better === d.id}><Icon n={better === d.id ? "loader" : "sparkles"} />Verbessern</button>}
          <button className="btn sec" onClick={() => skip(sel)} title="Taste S">{d.status === "uebersprungen" ? "Wieder aufnehmen" : "Überspringen"}</button>
          <button className="btn pri" onClick={() => approve(sel)} title="Taste A">{d.status === "freigegeben" ? "Freigegeben" : "Freigeben"}</button>
        </div>
      </div>}
    </div>
    {edit && <LeadDialog lead={edit} slug={t.slug} tenders={t.tenders} onClose={() => setEdit(null)} onSaved={onLeadSaved} />}
  </>;
}
