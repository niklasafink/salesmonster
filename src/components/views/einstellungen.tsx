"use client";
import { useCallback, useEffect, useState } from "react";
import { AI_PROVIDERS, INTEG, isAi, type Field } from "@/lib/integ-meta";
import { Logo, hasLogo } from "../logos";
import { Icon, Top, api, useDialog } from "../ui";
import type { Ctx, MailSync } from "../types";
import { DAY_NAMES, daysText, hh, planOf } from "@/lib/schedule";
import { Kosten } from "./kosten";

const when = (s: string) => new Date(s).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function Einstellungen({ ctx }: { ctx: Ctx }) {
  const t = ctx.st.tenant!;
  const [tab, setTab] = useState("ablauf");
  const tabs: [string, string][] = [["ablauf", "Ablauf"], ["integrationen", "Integrationen"], ["sperrliste", "Sperrliste"], ["team", "Team"], ["kosten", "Kosten"], ...(t.invoice ? [["rechnungen", "Rechnungen"] as [string, string]] : [])];
  return <>
    <Top title="Einstellungen" onMenu={ctx.openSidebar} />
    <div className="scroll"><div className="wrap narrow">
      <div className="tabs">{tabs.map(([k, n]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{n}</button>)}</div>
      {tab === "ablauf" ? <Ablauf ctx={ctx} /> : tab === "integrationen" ? <Integ ctx={ctx} /> : tab === "sperrliste" ? <Blocklist ctx={ctx} /> : tab === "team" ? <Team ctx={ctx} /> : tab === "kosten" ? <Kosten ctx={ctx} /> : <Billing ctx={ctx} />}
    </div></div>
  </>;
}

function Ablauf({ ctx }: { ctx: Ctx }) {
  const t = ctx.st.tenant!;
  const [n, setN] = useState(String(t.settings.leadsPerDay)), [busy, setBusy] = useState<string | null>(null);
  const [rounds, setRounds] = useState(String(t.settings.roundsPerDay ?? 0)), [hold, setHold] = useState(!!t.settings.holdTop);
  const plan = planOf(t.settings);
  const saveSettings = async (settings: object) => { try { await api(`/api/tenants/${t.slug}`, { method: "PATCH", body: { settings } }); ctx.reload(); } catch (e) { ctx.toast((e as Error).message, { error: true }); } };
  const clampR = (v: string) => v.trim() && Number.isFinite(Number(v)) ? Math.max(0, Math.min(24, Math.round(Number(v)))) : null;
  /* same bounds as the server: whole numbers 1..30 */
  const clampN = (v: string) => v.trim() && Number.isFinite(Number(v)) ? Math.max(1, Math.min(30, Math.round(Number(v)))) : null;
  async function saveN(v: string) {
    setN(v); const c = clampN(v); if (c === null) return;
    try { await api(`/api/tenants/${t.slug}`, { method: "PATCH", body: { settings: { leadsPerDay: c } } }); ctx.reload(); } catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }
  async function run(job: "research" | "send") {
    setBusy(job);
    try {
      const r = await api<{ created?: number; sent?: number; failed?: number }>("/api/run", { body: { t: t.slug, job } });
      ctx.toast(job === "research" ? `${r.created ?? 0} Entwürfe erstellt` : `${r.sent ?? 0} gesendet${r.failed ? `, ${r.failed} fehlgeschlagen` : ""}`);
      ctx.reload();
    } catch (e) { ctx.toast((e as Error).message, { error: true }); }
    setBusy(null);
  }
  return <>
    <div className="list-box">
      <label className="row2"><span>Leads pro Tag</span><input className="inp num" type="number" min={1} max={30} step={1} value={n} onChange={e => saveN(e.target.value)} onBlur={() => setN(String(clampN(n) ?? t.settings.leadsPerDay))} /></label>
      <label className="row2"><span>Weitere Recherche-Runden pro Tag</span><input className="inp num" type="number" min={0} max={24} step={1} value={rounds}
        onChange={e => { setRounds(e.target.value); const c = clampR(e.target.value); if (c !== null) saveSettings({ roundsPerDay: c }); }} onBlur={() => setRounds(String(clampR(rounds) ?? t.settings.roundsPerDay ?? 0))} /></label>
      <div className="row2"><span>Top-Leads für Dienstag und Mittwoch aufheben</span><button className={`sw ${hold ? "on" : ""}`} role="switch" aria-checked={hold} aria-label="Top-Leads für Dienstag und Mittwoch aufheben"
        onClick={() => { setHold(!hold); saveSettings({ holdTop: !hold }); }} /></div>
      <div className="row2"><span>Ausschreibungen je Lead suchen</span><button className={`sw ${t.tenders ? "on" : ""}`} role="switch" aria-checked={!!t.tenders} aria-label="Ausschreibungen je Lead suchen"
        onClick={async () => { try { await api(`/api/tenants/${t.slug}`, { method: "PATCH", body: { tenders: !t.tenders } }); ctx.reload(); } catch (e) { ctx.toast((e as Error).message, { error: true }); } }} /></div>
      {ctx.st.integ.sendpilot?.on && <LiCampaign ctx={ctx} save={saveSettings} />}
      <div className="row2"><span>Versandtage</span><div className="seg" role="group" aria-label="Versandtage">{DAY_NAMES.map((d, i) => { const on = plan.days.includes(i + 1);
        return <button key={d} className={on ? "on" : ""} aria-pressed={on} disabled={on && plan.days.length === 1}
          onClick={() => saveSettings({ sendDays: on ? plan.days.filter(x => x !== i + 1) : [...plan.days, i + 1] })}>{d}</button>; })}</div></div>
      <div className="row2"><span>Versandzeit</span><span className="row3">
        <select className="inp sel" aria-label="Versand ab" value={plan.from} onChange={e => { const f = Number(e.target.value); saveSettings({ sendFrom: f, sendTo: Math.max(plan.to, f + 1) }); }}>
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hh(h)}</option>)}</select>
        <span className="f3">bis</span>
        <select className="inp sel" aria-label="Versand bis" value={plan.to} onChange={e => saveSettings({ sendTo: Number(e.target.value) })}>
          {Array.from({ length: 24 - plan.from }, (_, i) => plan.from + 1 + i).map(h => <option key={h} value={h}>{hh(h)}</option>)}</select>
      </span></div>
      <div className="row2"><span>Recherche und Freigabe-Mail</span><span className="num f2">{daysText(plan.days.map(d => d === 1 ? 7 : d - 1))} 20:00</span></div>
    </div>
    <div className="row3">
      <button className="btn sec" onClick={() => run("research")} disabled={!!busy}>{busy === "research" && <Icon n="loader" />}Jetzt recherchieren</button>
      <button className="btn sec" onClick={() => run("send")} disabled={!!busy}><Icon n={busy === "send" ? "loader" : "send"} />Freigegebene jetzt senden</button>
    </div>
    {ctx.st.runs.length > 0 && <div className="list-box runs">{ctx.st.runs.map(r => <div key={r.id} className="row2">
      <span>{({ research: "Recherche", send: "Versand", enrich: "Ergänzung", round: "Recherche-Runde", loop: "Laufende Recherche", strategy: "Strategie", rating: "Bewertung", score: "Score", linkedin: "LinkedIn" } as Record<string, string>)[r.kind] || r.kind} <span className="f3 num">{when(r.createdAt)}</span></span>
      <span className={r.ok ? "f2" : ""} style={r.ok ? undefined : { color: "var(--r)" }}>{r.info}</span></div>)}</div>}
  </>;
}

/* LinkedIn leads go to this SendPilot campaign in the evening run; without one they wait for the LinkedIn button in the lead list */
function LiCampaign({ ctx, save }: { ctx: Ctx; save: (s: object) => Promise<void> }) {
  const t = ctx.st.tenant!;
  const [list, setList] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => { api<{ campaigns: { id: string; name: string }[] }>(`/api/sendpilot?t=${t.slug}`).then(r => setList(r.campaigns)).catch(() => setList([])); }, [t.slug]);
  const cur = t.settings.sendpilotCampaign || "";
  return <label className="row2"><span>LinkedIn-Leads an SendPilot</span>
    <select className="inp sel" value={cur} disabled={!list} onChange={e => save({ sendpilotCampaign: e.target.value })}>
      <option value="">Nur von Hand</option>
      {cur && list && !list.some(c => c.id === cur) && <option value={cur}>Kampagne nicht mehr offen</option>}
      {list?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select></label>;
}

/* What a provider card shows; kind is what the API stores ("mailbox" = IMAP and SMTP together) */
type Prov = { k: string; kind: string; name: string; ico: string; on: boolean; soon?: boolean };
type Form = { kind: string; name: string; fields: Field[]; fixed?: Record<string, string>; link?: [string, string]; guide?: string[] };

const GMAIL_SMTP = "smtp.gmail.com";
const MAILBOX: Field[] = [{ id: "user", label: "E-Mail", type: "email" }, { id: "pass", label: "Passwort", type: "password", secret: true }];
const FORMS: Record<string, Form> = {
  google: { kind: "mailbox", name: "Google", fields: [MAILBOX[0], { ...MAILBOX[1], label: "App-Passwort" }], fixed: { host: "imap.gmail.com", smtp: GMAIL_SMTP },
    link: ["https://myaccount.google.com/apppasswords", "App-Passwort bei Google erstellen"] },
  other: { kind: "mailbox", name: "Anderes Postfach", fields: [...MAILBOX, { id: "host", label: "IMAP-Server", optional: true, placeholder: "Automatisch" },
    { id: "smtp", label: "SMTP-Server", optional: true, placeholder: "Automatisch" }] },
};
const aiGuide = (name: string, model?: boolean) => [`Bei ${name} ein Konto anlegen und Guthaben aufladen`, "Einen neuen API-Schlüssel erstellen und kopieren",
  "Hier einfügen", ...(model ? ["Modell wählen, das die KI nutzen soll"] : [])];
const GUIDES: Record<string, string[]> = {
  google: ["Im Google-Konto die Bestätigung in zwei Schritten einschalten", "Über den Link unten ein App-Passwort erstellen, Name z. B. „Sales Monster“",
    "Das 16-stellige Passwort ohne Leerzeichen hier einfügen"],
  other: ["E-Mail und Passwort des Postfachs eintragen", "Server leer lassen, sie werden automatisch erkannt",
    "Klappt das nicht: IMAP- und SMTP-Server beim Anbieter nachsehen", "Mit Zwei-Faktor-Anmeldung ein App-Passwort beim Anbieter erstellen"],
  hubspot: ["In HubSpot Entwicklung → Alte Apps öffnen", "Alte App erstellen → Privat → Mit alter privater App fortfahren",
    "Unter Bereiche anhaken: crm.objects.contacts.read, crm.objects.contacts.write, crm.objects.companies.read, crm.objects.companies.write",
    "Webhooks leer lassen und App erstellen", "Zugriffstoken anzeigen, kopieren und hier einfügen"],
  sendpilot: ["In SendPilot in den Einstellungen unter API einen Schlüssel erstellen", "Die Webhook-URL unten in SendPilot als Webhook eintragen",
    "Das Signing-Secret des Webhooks kopieren und hier einfügen"],
  resend: ["In Resend unter Domains die Absender-Domain anlegen und die DNS-Einträge setzen", "Unter API Keys einen Schlüssel mit Sendezugriff erstellen",
    "Schlüssel einfügen, als Absender eine Adresse dieser Domain eintragen"],
  claude: aiGuide("Anthropic"), openrouter: aiGuide("OpenRouter", true), requesty: aiGuide("Requesty"), openai: aiGuide("OpenAI"),
};
const GROUPS = [["mail", "Mail"], ["ki", "KI"], ["sonstiges", "Sonstiges"]] as const;
type Group = (typeof GROUPS)[number][0];

function Mark({ p }: { p: Prov }) {
  return <span className="brand">{hasLogo(p.k) ? <Logo k={p.k} /> : <Icon n={p.ico} />}</span>;
}

function Integ({ ctx }: { ctx: Ctx }) {
  const { st } = ctx, t = st.tenant!;
  const [group, setGroup] = useState<Group | null>(null);
  const [form, setForm] = useState<Form | null>(null), [vals, setVals] = useState<Record<string, string>>({}), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const on = (k: string) => !!st.integ[k]?.on;
  const box = on("imap") || on("smtp"), gmail = box && st.integ.smtp?.detail === GMAIL_SMTP;
  const meta = (k: string) => INTEG.find(i => i.k === k)!;
  const items: Record<Group, Prov[]> = {
    mail: [{ k: "microsoft", kind: "outlook", name: "Microsoft 365", ico: "mail", on: on("outlook") },
      { k: "google", kind: "mailbox", name: "Google", ico: "mail", on: gmail },
      { k: "other", kind: "mailbox", name: "Anderes Postfach", ico: "mail", on: box && !gmail }],
    ki: AI_PROVIDERS.map(p => ({ k: p.k, kind: p.k, name: p.name, ico: "sparkles", on: on(p.k) })),
    sonstiges: (["hubspot", "sendpilot", "resend", ...(t.tenders ? ["vergabehero"] : [])] as const).map(k => { const m = meta(k);
      return { k, kind: k, name: m.name, ico: m.ico, on: on(k), soon: m.auth === "pending" }; }),
  };
  function open(p: Prov) {
    if (p.kind === "outlook") { location.href = `/api/integrations/microsoft?t=${t.slug}`; return; }
    const m = INTEG.find(i => i.k === p.kind);
    const f = { guide: GUIDES[p.k], ...(FORMS[p.k] || { kind: p.kind, name: p.name, fields: m!.fields!, link: isAi(p.k) ? [AI_PROVIDERS.find(a => a.k === p.k)!.keys, `Schlüssel bei ${p.name} erstellen`] : undefined }) };
    setVals(Object.fromEntries(f.fields.map(x => [x.id, x.id === "user" ? st.me.email : x.value || ""]))); setErr(""); setForm(f);
  }
  async function connect(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    try { await api("/api/integrations", { body: { t: t.slug, kind: form!.kind, values: { ...vals, ...form!.fixed } } }); ctx.toast(`${form!.name} verbunden`); setForm(null); ctx.reload(); }
    catch (e2) { setErr((e2 as Error).message); }
    setBusy(false);
  }
  const ref = useDialog(() => setForm(null));
  async function disconnect(kind: string) {
    try { await api(`/api/integrations?t=${t.slug}&kind=${kind}`, { method: "DELETE" }); ctx.reload(); } catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }
  return <>
    {!group ? <div className="tiles">{GROUPS.map(([g, name]) => <button key={g} type="button" className="tile" onClick={() => setGroup(g)}>
      <span className="tile-h">{name}<Icon n="arrow-right" /></span>
      <span className="marks">{items[g].map(p => <span key={p.k} className={p.on ? "" : "off"} title={p.name}><Mark p={p} /></span>)}</span>
    </button>)}</div> : <>
      <div className="crumb"><button type="button" className="btn gh" onClick={() => setGroup(null)}><Icon n="arrow-left" />Integrationen</button>
        <span className="f3">/</span><span>{GROUPS.find(([g]) => g === group)![1]}</span></div>
      <div className="provs">{items[group].map(p => <div key={p.k} className="prov int">
        <Mark p={p} /><span className="nm">{p.name}</span>
        {p.on ? <><span className="pill g">Verbunden</span><button className="btn gh act" onClick={() => disconnect(p.kind)}>Trennen</button></>
          : p.soon ? <span className="pill">Demnächst</span> : <button className="btn sec" onClick={() => open(p)} aria-label={`${p.name} verbinden`}>Verbinden</button>}
      </div>)}</div>
      {group === "mail" && (on("outlook") || on("imap")) && <Contacts ctx={ctx} />}
      {group === "ki" && <><AiPick ctx={ctx} /><Connector ctx={ctx} /></>}
      {group === "sonstiges" && on("hubspot") && <CrmSync ctx={ctx} />}
    </>}
    {form && <div className="ov" onClick={e => e.target === e.currentTarget && setForm(null)}><form className="dlg" ref={ref} role="dialog" aria-modal="true" aria-label={`${form.name} verbinden`} onSubmit={connect}>
      <div className="dlg-h">{form.name} verbinden<button type="button" className="btn gh ic" onClick={() => setForm(null)} aria-label="Schließen"><Icon n="x" /></button></div>
      {form.guide && <details className="howto"><summary>Du brauchst eine Anleitung?</summary><ul>{form.guide.map(g => <li key={g}>{g}</li>)}</ul></details>}
      {form.fields.map((f, i) => <label key={f.id} className="fld"><span>{f.label}</span>{f.options
        ? <select className="inp" value={vals[f.id] || ""} onChange={e => setVals({ ...vals, [f.id]: e.target.value })}>{f.options.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
        : <input className="inp" type={f.type || "text"} value={vals[f.id] || ""} placeholder={f.placeholder} autoFocus={i === 0} autoComplete="off" onChange={e => setVals({ ...vals, [f.id]: e.target.value })} />}</label>)}
      {form.link && <a className="f2" href={form.link[0]} target="_blank" rel="noreferrer">{form.link[1]}</a>}
      {form.kind === "sendpilot" && <label className="fld"><span>Webhook-URL für SendPilot</span><input className="inp mono" readOnly value={`${location.origin}/api/sendpilot/webhook/${t.slug}`} onFocus={e => e.target.select()} /></label>}
      {err && <div className="warn">{err}</div>}
      <button className="btn pri wide" disabled={busy}>{busy ? <Icon n="loader" /> : null}Verbinden</button>
    </form></div>}
  </>;
}

/* Keys belong to the account; each tenant picks which of them answers, without connecting again */
function AiPick({ ctx }: { ctx: Ctx }) {
  const { st } = ctx, t = st.tenant!;
  if (!st.ai.options.length) return null;
  async function pick(id: string) {
    try { await api(`/api/tenants/${t.slug}`, { method: "PATCH", body: { settings: { ai: id || null } } }); ctx.reload(); } catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }
  return <div className="list-box">
    <label className="row2 int"><span className="nm"><Icon n="sparkles" />KI für {t.name}</span>
      <select className="inp sel" value={st.ai.current || ""} onChange={e => pick(e.target.value)}>
        {!st.ai.current && <option value="">{st.ai.options[0].label}</option>}
        {st.ai.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select></label>
  </div>;
}

const n = (x: number) => x.toLocaleString("de-DE");

/* The mailbox read into the contacts; the page drives the run step by step while it is open, the morning cron continues it */
function Contacts({ ctx }: { ctx: Ctx }) {
  const t = ctx.st.tenant!;
  const [s, setS] = useState<MailSync | null>(ctx.st.mailSync), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (s?.status !== "läuft" || busy) return;
    let stop = false;
    (async () => {
      setBusy(true);
      try {
        let cur: MailSync | null = s;
        while (!stop && cur?.status === "läuft") { cur = await api<MailSync | null>("/api/mail-sync", { body: { t: t.slug, action: "step" } }); if (!stop) setS(cur); }
        if (!stop && cur?.status === "fertig") ctx.toast(`${n(cur.imported)} Kontakte im CRM`, { label: "Anzeigen", href: "#leads" });
      } catch (e) { if (!stop) ctx.toast((e as Error).message, { error: true }); }
      if (!stop) setBusy(false);
    })();
    return () => { stop = true; };
  }, [s?.status, t.slug]); // eslint-disable-line react-hooks/exhaustive-deps
  async function start() {
    try { setS(await api<MailSync | null>("/api/mail-sync", { body: { t: t.slug, action: "start" } })); } catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }
  const run = s?.status === "läuft";
  const what = !s ? "" : run ? s.phase === "scan" ? `${n(s.scanned)} E-Mails gelesen` : s.phase === "signatur" ? `Signaturen von ${n(s.contacts)} Kontakten` : "Übernehme Kontakte" : `${n(s.imported)} Kontakte`;
  return <div className="list-box">
    <div className="row2 int"><span className="nm"><Icon n="users" />Kontakte aus E-Mails{s?.status === "fehler" && <span className="pill r">Fehler</span>}</span>
      <span className="row3">{what && <span className="f2 num">{run && <Icon n="loader" />}{what}</span>}
        {!run && <button className="btn sec" onClick={start}>{s ? "Aktualisieren" : "Importieren"}</button>}</span></div>
    {s?.status === "fehler" && <div className="row2"><span className="f2">{s.error}</span></div>}
  </div>;
}

type Crm = { hubspot: boolean; property: string; value: string; status: string; error: string; lastRunAt: string | null; imported: number; updated: number; contacts: number };

/* Registered users from HubSpot (the leading system) as CRM contacts: which property marks a registration, and the sync driven while the page is open */
function CrmSync({ ctx }: { ctx: Ctx }) {
  const t = ctx.st.tenant!;
  const [s, setS] = useState<Crm | null>(null), [prop, setProp] = useState(""), [val, setVal] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { api<Crm>(`/api/crm?t=${t.slug}`).then(r => { setS(r); setProp(r.property); setVal(r.value); }).catch(e => ctx.toast((e as Error).message, { error: true })); }, [t.slug]); // eslint-disable-line react-hooks/exhaustive-deps
  async function run() {
    setBusy(true);
    try {
      let cur = await api<Crm>("/api/crm", { method: "PUT", body: { t: t.slug, property: prop, value: val } });
      setS(cur);
      if (cur.property) do { cur = await api<Crm>("/api/crm", { body: { t: t.slug } }); setS(cur); } while (cur.status === "läuft");
      if (cur.status === "fehler") ctx.toast(cur.error, { error: true });
      else if (cur.property) ctx.toast(`${n(cur.contacts)} Kontakte im CRM`, { label: "Anzeigen", href: "#leads" });
      else ctx.toast("Abgleich ausgeschaltet");
    } catch (e) { ctx.toast((e as Error).message, { error: true }); }
    setBusy(false);
  }
  if (!s) return null;
  const changed = prop.trim() !== s.property || val.trim() !== s.value;
  return <div className="list-box">
    <div className="row2 int"><span className="nm"><Icon n="user-check" />CRM aus HubSpot{s.status === "fehler" && <span className="pill r">Fehler</span>}</span>
      <span className="row3"><span className="f2 num">{busy && <Icon n="loader" />}{s.property ? `${n(s.contacts)} registriert` : "Aus"}</span>
        <button className="btn sec" onClick={run} disabled={busy || (!prop.trim() && !s.property)}>{!prop.trim() && s.property ? "Ausschalten" : changed ? "Speichern und abgleichen" : "Jetzt abgleichen"}</button></span></div>
    <label className="row2"><span>Registriert, wenn diese HubSpot-Eigenschaft gesetzt ist</span><input className="inp" value={prop} placeholder="z. B. signup_datum" onChange={e => setProp(e.target.value)} /></label>
    <label className="row2"><span>und diesen Wert hat (leer = beliebig)</span><input className="inp" value={val} placeholder="beliebig" onChange={e => setVal(e.target.value)} /></label>
    <div className="row2"><span className="f3">Jede Stunde gleicht Sales Monster neue und geänderte Kontakte ab. Registrierte bekommen keine Kaltakquise mehr.{s.lastRunAt && ` Zuletzt ${when(s.lastRunAt)}.`}</span></div>
    {s.status === "fehler" && <div className="row2"><span className="f2">{s.error}</span></div>}
  </div>;
}

type Sup = { id: number; kind: string; value: string; reason: string; note: string; createdAt: string };
const SUP_KIND: Record<string, string> = { email: "Adresse", domain: "Domain", linkedin: "LinkedIn" };
const SUP_WHY: Record<string, string> = { abgemeldet: "Abgemeldet", unzustellbar: "Unzustellbar", hubspot: "Opt-out in HubSpot", manuell: "Von Hand" };

/* Who is never written to: added here, by unsubscribes, bounces and HubSpot opt-outs; checked before every draft, send, sequence mail, import and SendPilot */
function Blocklist({ ctx }: { ctx: Ctx }) {
  const t = ctx.st.tenant!;
  const [d, setD] = useState<{ total: number; rows: Sup[] } | null>(null), [q, setQ] = useState(""), [text, setText] = useState(""), [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ total: number; rows: Sup[] }>(`/api/suppressions?t=${t.slug}&q=${encodeURIComponent(q.trim())}`).then(setD).catch(e => ctx.toast((e as Error).message, { error: true })), [t.slug, q, ctx]);
  useEffect(() => { const h = setTimeout(load, 200); return () => clearTimeout(h); }, [load]);
  async function add() {
    setBusy(true);
    try {
      const r = await api<{ added: number; invalid: string[] }>("/api/suppressions", { body: { t: t.slug, entries: text } });
      ctx.toast([`${n(r.added)} gesperrt`, r.invalid.length && `${r.invalid.length} nicht erkannt: ${r.invalid.slice(0, 3).join(", ")}`].filter(Boolean).join(", "), r.invalid.length ? { error: true } : undefined);
      if (!r.invalid.length) setText(""); else setText(r.invalid.join("\n"));
      load();
    } catch (e) { ctx.toast((e as Error).message, { error: true }); }
    setBusy(false);
  }
  async function remove(id: number) {
    try { await api(`/api/suppressions?t=${t.slug}&id=${id}`, { method: "DELETE" }); load(); } catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }
  return <>
    <div className="list-box">
      <label className="row2 col"><span>Adressen, Domains oder LinkedIn-Profile, eine pro Zeile</span>
        <textarea className="inp" rows={3} value={text} placeholder={"max@firma.de\nwettbewerber.de\nlinkedin.com/in/name"} onChange={e => setText(e.target.value)} /></label>
      <div className="row2"><span className="f3">Gesperrte bekommen keine Entwürfe, keine Mails, keine Strecken-Mails und kommen nicht zu SendPilot. Freemail-Domains wie gmail.com lassen sich nur als einzelne Adresse sperren.</span>
        <button className="btn" onClick={add} disabled={busy || !text.trim()}>{busy && <Icon n="loader" />}Sperren</button></div>
    </div>
    <div className="list-box">
      <div className="row2"><div className="search"><Icon n="search" /><input className="inp" placeholder="Suchen" value={q} onChange={e => setQ(e.target.value)} aria-label="Sperrliste durchsuchen" /></div>
        <span className="f3 num">{d ? `${n(d.total)} Einträge` : ""}</span></div>
      {d?.rows.map(r => <div key={r.id} className="row2"><span><span className="mono">{r.value}</span> <span className="f3">{SUP_KIND[r.kind] || r.kind} · {SUP_WHY[r.reason] || r.reason}{r.note && ` · ${r.note}`} · {when(r.createdAt)}</span></span>
        <button className="btn gh act" onClick={() => remove(r.id)}>Entfernen</button></div>)}
      {d && !d.rows.length && <div className="row2"><span className="f3">{q ? "Keine Treffer." : "Noch niemand gesperrt."}</span></div>}
    </div>
  </>;
}

type Grant = { id: number; clientName: string; createdAt: string; lastUsedAt: string | null };

/* Claude in claude.ai as custom connector: per person, not per tenant */
function Connector({ ctx }: { ctx: Ctx }) {
  const [d, setD] = useState<{ url: string; grants: Grant[] } | null>(null);
  const load = () => api<{ url: string; grants: Grant[] }>("/api/oauth/grants").then(setD).catch(e => ctx.toast((e as Error).message, { error: true }));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function copy() {
    try { await navigator.clipboard.writeText(d!.url); ctx.toast("URL kopiert"); } catch { ctx.toast("Kopieren nicht möglich", { error: true }); }
  }
  async function revoke(id: number) {
    try { await api(`/api/oauth/grants?id=${id}`, { method: "DELETE" }); load(); } catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }
  if (!d) return null;
  return <div className="list-box">
    <div className="row2 int"><span className="nm"><Icon n="sparkles" />Claude-Connector{d.grants.length > 0 && <span className="pill g">Verbunden</span>}</span></div>
    <div className="row2"><input className="inp url" readOnly value={d.url} aria-label="Connector-URL" onFocus={e => e.target.select()} />
      <button className="btn sec" onClick={copy}><Icon n="copy" />Kopieren</button></div>
    {d.grants.map(g => <div key={g.id} className="row2"><span>{g.clientName} <span className="f3 num">{when(g.lastUsedAt || g.createdAt)}</span></span>
      <button className="btn gh act" onClick={() => revoke(g.id)}>Trennen</button></div>)}
  </div>;
}

/* Who works in this tenant; others join through a single-use link */
function Team({ ctx }: { ctx: Ctx }) {
  const { st } = ctx, t = st.tenant!;
  const [url, setUrl] = useState("");
  async function invite() {
    try {
      const r = await api<{ url: string }>("/api/invites", { body: { t: t.slug } }); setUrl(r.url);
      try { await navigator.clipboard.writeText(r.url); ctx.toast("Link kopiert"); } catch { /* shown in the field */ }
    } catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }
  async function remove(id: number) {
    try { await api(`/api/members?t=${t.slug}&user=${id}`, { method: "DELETE" }); if (id === st.me.id) location.href = "/"; else ctx.reload(); }
    catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }
  return <>
    <div className="list-box">{st.users.map(u => <div key={u.id} className="row2"><span>{u.name} <span className="f3">{u.email}</span></span>
      {st.users.length > 1 && <button className="btn gh act" onClick={() => remove(u.id)}>{u.id === st.me.id ? "Verlassen" : "Entfernen"}</button>}</div>)}</div>
    {url && <div className="list-box"><div className="row2"><input className="inp url" readOnly value={url} aria-label="Einladungslink" onFocus={e => e.target.select()} />
      <button className="btn sec" onClick={() => navigator.clipboard.writeText(url).then(() => ctx.toast("Link kopiert"))}><Icon n="copy" />Kopieren</button></div></div>}
    <div><button className="btn" onClick={invite}><Icon n="user-plus" />Einladen</button></div>
  </>;
}

function Billing({ ctx }: { ctx: Ctx }) {
  const t = ctx.st.tenant!, inv = t.invoice!;
  const [s, setS] = useState(inv.seller), [no, setNo] = useState(String(inv.nextNo)), [plans, setPlans] = useState(inv.plans);
  const F: [keyof typeof s, string][] = [["name", "Firma"], ["street", "Straße"], ["city", "PLZ und Ort"], ["gf", "Geschäftsführer"], ["hrb", "Handelsregister"], ["court", "Registergericht"],
    ["tax", "Steuernummer / USt-IdNr."], ["iban", "IBAN"], ["bic", "BIC"], ["email", "E-Mail für Rechnungen"]];
  async function save() {
    try { await api(`/api/tenants/${t.slug}`, { method: "PATCH", body: { invoice: { seller: s, nextNo: Number(no) || inv.nextNo, plans } } }); ctx.toast("Gespeichert"); ctx.reload(); }
    catch (e) { ctx.toast((e as Error).message, { error: true }); }
  }
  return <>
    <div className="form">{F.map(([k, l]) => <label key={k} className="fld"><span>{l}</span><input className="inp" value={s[k]} onChange={e => setS({ ...s, [k]: e.target.value })} /></label>)}</div>
    <div className="list-box">
      <label className="row2"><span>Nächste Rechnungsnummer</span><input className="inp num" inputMode="numeric" value={no} onChange={e => setNo(e.target.value.replace(/\D/g, ""))} /></label>
      {plans.map((p, i) => <label key={p.key} className="row2"><span>{p.n} pro Monat</span><input className="inp num" inputMode="decimal" value={p.m} onChange={e => setPlans(plans.map((x, k) => k === i ? { ...x, m: Number(e.target.value.replace(",", ".").replace(/[^\d.]/g, "")) || 0 } : x))} /></label>)}
    </div>
    <div><button className="btn" onClick={save}>Speichern</button></div>
  </>;
}
