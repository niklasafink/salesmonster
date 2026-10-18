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
          <svg viewBox="0 0 32 32" width="22" height="22" fill="#000" stroke="#000" strokeWidth="2" strokeLinejoin="round"><path d="M28.5 3.5 3.5 13.5l9 4.5Z" /><path d="M28.5 3.5 14 19.5l4.5 9Z" /></svg>
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
