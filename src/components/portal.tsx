"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, api } from "./ui";
import type { Ctx, State } from "./types";
import { Freigabe, approveAllDrafts } from "./views/freigabe";
import { Uebersicht } from "./views/uebersicht";
import { Leads } from "./views/leads";
import { Vorlagen } from "./views/vorlagen";
import { Einstellungen } from "./views/einstellungen";
import { Rechnungen } from "./views/rechnungen";
import { Einrichtung } from "./views/einrichtung";
import { Workflows } from "./views/workflows";

const VIEWS: Record<string, [string, string]> = {
  einrichtung: ["Einrichtung", "sparkles"],
  freigabe: ["Freigabe", "inbox"], statistik: ["Übersicht", "layout-dashboard"], leads: ["Leads", "users"],
  vorlagen: ["Vorlagen", "file-text"], workflows: ["Workflows", "workflow"], rechnungen: ["Rechnungen", "receipt-text"], einstellungen: ["Einstellungen", "settings-2"],
};

const ls = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

export function toggleTheme() {
  const r = document.documentElement, dark = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  r.dataset.theme = dark ? "light" : "dark"; ls.set("oc-theme", r.dataset.theme);
}

type Toast = { m: string; action?: { label: string; href: string } } | null;

export default function Portal() {
  const [st, setSt] = useState<State | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [view, setViewS] = useState("freigabe");
  const [pop, setPop] = useState<null | "me">(null);
  const [sbo, setSbo] = useState(false);
  const [pal, setPal] = useState(false), [palQ, setPalQ] = useState(""), [palI, setPalI] = useState(0);
  const [toastS, setToast] = useState<Toast>(null);
  const [dlg, setDlg] = useState<null | "ws" | "tenant" | "pw">(null);
  const [focusLead, setFocusLead] = useState<number | null>(null);
  const tt = useRef<ReturnType<typeof setTimeout>>(undefined);

  const toast = useCallback((m: string, action?: { label: string; href: string }) => {
    setToast({ m, action }); clearTimeout(tt.current); tt.current = setTimeout(() => setToast(null), action ? 5200 : 2600);
  }, []);

  const load = useCallback(async (s: string | null) => {
    const j = await api<State>(`/api/state${s ? `?t=${encodeURIComponent(s)}` : ""}`);
    setSt(j);
    if (j.tenant && j.tenant.slug !== s) { setSlug(j.tenant.slug); ls.set("sp-tenant", j.tenant.slug); }
    /* a fresh tenant opens in the guided setup */
    if (j.tenant && !j.setup.started && !j.drafts.length && !location.hash) setViewS("einrichtung");
  }, []);
  const reload = useCallback(() => load(slug), [load, slug]);

  useEffect(() => {
    const s = ls.get("sp-tenant"); setSlug(s);
    const h = location.hash.slice(1); if (VIEWS[h]) setViewS(h);
    const msg = new URLSearchParams(location.search).get("msg");
    if (msg) { toast(msg); history.replaceState(null, "", location.pathname + location.hash); }
    load(s).catch(e => toast(e.message));
    const onHash = () => { const v = location.hash.slice(1); if (VIEWS[v]) setViewS(v); };
    addEventListener("hashchange", onHash); return () => removeEventListener("hashchange", onHash);
  }, [load, toast]);

  const setView = useCallback((v: string) => { setViewS(v); setSbo(false); try { history.replaceState(null, "", "#" + v); } catch { /* ignore */ } }, []);
  const switchTenant = useCallback((s: string) => { setSlug(s); ls.set("sp-tenant", s); setPop(null); setDlg(null); load(s).catch(e => toast(e.message)); }, [load, toast]);

  const hasInvoice = !!st?.tenant?.invoice;
  const navKeys = Object.keys(VIEWS).filter(v => (v !== "rechnungen" || hasInvoice));
  const curView = view === "rechnungen" && st && !hasInvoice ? "freigabe" : view;

  const ctx: Ctx | null = st ? { st, reload, toast, setView, openSidebar: () => setSbo(true) } : null;

  /* Command palette */
  const cmds = useMemo(() => {
    if (!st) return [];
    const c: { g: string; ic: string; n: string; run: () => void }[] = [
      ...navKeys.map(v => ({ g: "Gehe zu", ic: VIEWS[v][1], n: VIEWS[v][0], run: () => setView(v) })),
      ...st.tenants.filter(t => t.slug !== st.tenant?.slug).map(t => ({ g: "Mandant", ic: "building-2", n: `Wechseln zu ${t.name}`, run: () => switchTenant(t.slug) })),
      { g: "Aktion", ic: "check-check", n: "Alle freigeben", run: async () => { setView("freigabe"); try { const n = await approveAllDrafts(st); await reload(); toast(n ? `${n} Nachrichten freigegeben` : "Alles ist schon freigegeben"); } catch (e) { toast((e as Error).message); } } },
      { g: "Aktion", ic: "target", n: "Zielgruppe bearbeiten", run: () => setView("einstellungen") },
      { g: "Aktion", ic: "sparkles", n: "Mit KI einrichten", run: () => setView("einrichtung") },
      { g: "Aktion", ic: "sun-moon", n: "Hell / Dunkel umschalten", run: () => toggleTheme() },
      ...st.drafts.map(d => ({ g: "Leads heute", ic: "user", n: d.lead.company, run: () => { setView("freigabe"); setFocusLead(d.id); } })),
    ];
    const q = palQ.toLowerCase(); return c.filter(x => !q || x.n.toLowerCase().includes(q));
  }, [st, palQ, navKeys, setView, switchTenant, reload, toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPal(p => !p); setPalQ(""); setPalI(0); return; }
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key) && st) { const t = st.tenants[+e.key - 1]; if (t) { e.preventDefault(); switchTenant(t.slug); } return; }
      if (pal) {
        const n = cmds.length;
        if (e.key === "Escape") setPal(false);
        else if (e.key === "ArrowDown") { e.preventDefault(); setPalI(i => (i + 1) % Math.max(n, 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setPalI(i => (i - 1 + n) % Math.max(n, 1)); }
        else if (e.key === "Enter") { e.preventDefault(); const c = cmds[palI]; setPal(false); c?.run(); }
        return;
      }
      if (e.key === "Escape") { if (dlg) setDlg(null); else if (pop) setPop(null); }
    };
    addEventListener("keydown", onKey); return () => removeEventListener("keydown", onKey);
  }, [pal, cmds, palI, st, switchTenant, dlg, pop]);

  if (!st || !ctx) return <div id="app"><aside className="sb" /><main className="main" /></div>;

  const t = st.tenant;
  const open = st.drafts.filter(d => d.status === "entwurf").length;
  const nav = (v: string) => (
    <button key={v} className={`nav ${curView === v ? "on" : ""}`} onClick={() => setView(v)}>
      <Icon n={VIEWS[v][1]} />{VIEWS[v][0]}{v === "freigabe" && open ? <span className="cnt">{open}</span> : null}
    </button>);

  let g = "";
  return (
    <>
      <div id="app" className={sbo ? "sbo" : ""} onClick={e => { if (sbo && !(e.target as HTMLElement).closest(".sb")) setSbo(false); }}>
        <aside className="sb">
          <button className="ws" onClick={() => { setPop(null); setDlg("ws"); }}>{t && <TenantIcon key={t.slug} t={t} />}{t?.name || "Kein Mandant"}<Icon n="chevrons-up-down" /></button>
          <button className="find" onClick={() => { setPal(true); setPalQ(""); setPalI(0); }} title="⌘K"><Icon n="search" />Suchen</button>
          {navKeys.map(nav)}
          <div className="sb-foot">
            <div className="rel">
              {pop === "me" && <div className="pop" style={{ bottom: 42 }}>
                <button onClick={() => { setPop(null); setDlg("pw"); }}><Icon n="key-round" />Passwort ändern</button>
                <button onClick={() => { toggleTheme(); setPop(null); }}><Icon n="sun-moon" />Hell / Dunkel</button>
                <hr /><button onClick={async () => { await api("/api/auth/logout", { method: "POST" }); location.href = "/login"; }}><Icon n="log-out" />Abmelden</button>
              </div>}
              <button className="me" onClick={() => setPop(pop === "me" ? null : "me")}>{st.me.name}<Icon n="chevrons-up-down" /></button>
            </div>
          </div>
        </aside>
        <main className="main" onClick={() => pop && setPop(null)}>
          {!t ? <div className="empty"><div><div className="h2">Noch kein Mandant</div><button className="btn pri" onClick={() => setDlg("tenant")}><Icon n="plus" />Mandant hinzufügen</button></div></div>
            : curView === "freigabe" ? <Freigabe key={t.slug} ctx={ctx} focus={focusLead} onFocused={() => setFocusLead(null)} />
            : curView === "statistik" ? <Uebersicht key={t.slug} ctx={ctx} />
            : curView === "leads" ? <Leads key={t.slug} ctx={ctx} />
            : curView === "vorlagen" ? <Vorlagen key={t.slug} ctx={ctx} />
            : curView === "workflows" ? <Workflows key={t.slug} ctx={ctx} />
            : curView === "rechnungen" ? <Rechnungen key={t.slug} ctx={ctx} />
            : curView === "einrichtung" ? <Einrichtung key={t.slug} ctx={ctx} />
            : <Einstellungen key={t.slug} ctx={ctx} />}
        </main>
      </div>

      {pal && <div className="ov" onClick={e => e.target === e.currentTarget && setPal(false)}><div className="pal">
        <input autoFocus placeholder="Suchen oder Befehl eingeben" value={palQ} onChange={e => { setPalQ(e.target.value); setPalI(0); }} aria-label="Befehl suchen" autoComplete="off" />
        <div className="items">{cmds.length ? cmds.map((c, i) => { const head = c.g !== g ? <div className="grp">{c.g}</div> : null; g = c.g;
          return <div key={c.g + c.n + i}>{head}<button className={i === palI ? "hi" : ""} onMouseEnter={() => setPalI(i)} onClick={() => { setPal(false); c.run(); }}><Icon n={c.ic} />{c.n}</button></div>; })
          : <div className="grp">Nichts gefunden</div>}</div>
      </div></div>}

      {dlg === "ws" && <div className="ov" onClick={e => e.target === e.currentTarget && setDlg(null)}><div className="dlg" role="dialog" aria-label="Unternehmen">
        <div className="dlg-h">Unternehmen<button type="button" className="btn gh ic" onClick={() => setDlg(null)} aria-label="Schließen"><Icon n="x" /></button></div>
        <div className="tl">
          {st.tenants.map((x, i) => <button key={x.slug} className={x.slug === t?.slug ? "on" : ""} onClick={() => switchTenant(x.slug)} autoFocus={x.slug === t?.slug}>
            <TenantIcon t={x} /><span className="nm">{x.name}</span>{x.slug === t?.slug ? <Icon n="check" className="end" /> : i < 9 && <span className="k end">⌘{i + 1}</span>}
          </button>)}
        </div>
        <button className="btn wide" onClick={() => setDlg("tenant")}><Icon n="plus" />Unternehmen hinzufügen</button>
      </div></div>}
      {dlg === "tenant" && <TenantDialog onClose={() => setDlg(null)} onDone={s => { setDlg(null); switchTenant(s); setView("einrichtung"); }} />}
      {dlg === "pw" && <PwDialog onClose={() => setDlg(null)} onDone={() => { setDlg(null); toast("Passwort geändert"); }} />}

      {toastS && <div className="toast"><Icon n="check" /><span>{toastS.m}</span>{toastS.action && <a className="btn" href={toastS.action.href}><Icon n="download" />{toastS.action.label}</a>}</div>}
    </>
  );
}

/* Website icon of the tenant, initials until it loads or when there is none */
function TenantIcon({ t }: { t: { slug: string; initials: string } }) {
  const [ok, setOk] = useState(false), [bad, setBad] = useState(false);
  return <span className="tic">{!ok && t.initials.slice(0, 2)}{!bad && <img src={`/api/tenants/${t.slug}/icon`} alt="" hidden={!ok} onLoad={() => setOk(true)} onError={() => { setBad(true); setOk(false); }} />}</span>;
}

function TenantDialog({ onClose, onDone }: { onClose: () => void; onDone: (slug: string) => void }) {
  const [name, setName] = useState(""), [domain, setDomain] = useState(""), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  return <div className="ov" onClick={e => e.target === e.currentTarget && onClose()}><form className="dlg" onSubmit={async e => {
    e.preventDefault(); setBusy(true); setErr("");
    try { const r = await api<{ slug: string }>("/api/tenants", { body: { name, domain } }); onDone(r.slug); } catch (x) { setErr((x as Error).message); setBusy(false); }
  }}>
    <div className="dlg-h">Unternehmen hinzufügen<button type="button" className="btn gh ic" onClick={onClose} aria-label="Schließen"><Icon n="x" /></button></div>
    <label className="fld"><span>Name</span><input className="inp" value={name} onChange={e => setName(e.target.value)} autoFocus /></label>
    <label className="fld"><span>Domain</span><input className="inp" value={domain} onChange={e => setDomain(e.target.value)} placeholder="firma.de" /></label>
    {err && <div className="warn">{err}</div>}
    <button className="btn pri wide" disabled={busy}>Anlegen</button>
  </form></div>;
}

function PwDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [cur, setCur] = useState(""), [next, setNext] = useState(""), [err, setErr] = useState("");
  return <div className="ov" onClick={e => e.target === e.currentTarget && onClose()}><form className="dlg" onSubmit={async e => {
    e.preventDefault(); setErr("");
    try { await api("/api/auth/password", { body: { current: cur, next } }); onDone(); } catch (x) { setErr((x as Error).message); }
  }}>
    <div className="dlg-h">Passwort ändern<button type="button" className="btn gh ic" onClick={onClose} aria-label="Schließen"><Icon n="x" /></button></div>
    <label className="fld"><span>Aktuelles Passwort</span><input className="inp" type="password" autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} autoFocus /></label>
    <label className="fld"><span>Neues Passwort</span><input className="inp" type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} /></label>
    {err && <div className="warn">{err}</div>}
    <button className="btn pri wide">Speichern</button>
  </form></div>;
}
