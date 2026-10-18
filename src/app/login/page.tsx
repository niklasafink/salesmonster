"use client";
import { useState } from "react";
import { Eye, EyeOff, ArrowRight, Loader2 } from "lucide-react";

export default function Login() {
  const [email, setEmail] = useState(""), [pw, setPw] = useState(""), [show, setShow] = useState(false), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    const r = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: pw }) });
    if (r.ok) location.href = "/";
    else { setErr((await r.json()).error || "Anmeldung fehlgeschlagen"); setBusy(false); }
  }
  return (
    <div className="login">
      <aside className="lg-art" aria-hidden>
        <div className="lg-mesh"><i /><i /><i /><i /></div>
        <svg className="lg-grain"><filter id="lg-noise"><feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="3" stitchTiles="stitch" /></filter><rect width="100%" height="100%" filter="url(#lg-noise)" /></svg>
        <div className="lg-brand">
          <svg viewBox="0 0 32 32" width="26" height="26"><mask id="lg-logo"><rect width="32" height="32" fill="#fff" /><circle cx="16" cy="14" r="4.4" /><circle cx="17.1" cy="13.1" r="1.8" fill="#fff" />
            <path d="M9.6 25l3.9-3.1 3 2 5.7-4.4M19.2 19.5h3v3" fill="none" stroke="#000" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" /></mask>
            <path mask="url(#lg-logo)" fill="#000" d="M9.2 7.6Q5.6 6.4 5.2 1.8Q8.6 4.6 12.6 5.9A11 11 0 0 1 19.4 5.9Q23.4 4.6 26.8 1.8Q26.4 6.4 22.8 7.6A10 10 0 0 1 27 15.5V25a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V15.5A10 10 0 0 1 9.2 7.6Z" /></svg>
          Sales Monster
        </div>
      </aside>
      <main className="lg-side">
        <form className="lg-form" onSubmit={submit}>
          <h1>Anmelden</h1>
          <label className="fld"><span>E-Mail</span><input className="inp" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} autoFocus required /></label>
          <label className="fld"><span>Passwort</span>
            <span className="lg-pw">
              <input className="inp" type={show ? "text" : "password"} autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} required />
              <button type="button" onClick={() => setShow(s => !s)} aria-label={show ? "Passwort verbergen" : "Passwort anzeigen"}>{show ? <EyeOff /> : <Eye />}</button>
            </span>
          </label>
          {err && <div className="warn">{err}</div>}
          <button className="btn pri wide lg-go" disabled={busy}>{busy ? <Loader2 className="spin" /> : <>Anmelden<ArrowRight /></>}</button>
        </form>
      </main>
    </div>
  );
}
