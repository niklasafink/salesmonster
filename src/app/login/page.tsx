"use client";
import { useState } from "react";
import { Eye, EyeOff, ArrowRight, Loader2 } from "lucide-react";

/* Beam paths for the art panel: curves fanning out from the lower left */
const BEAMS = [
  "M-40 820 C 180 640, 260 420, 620 300",
  "M-40 760 C 220 600, 320 360, 640 200",
  "M-40 880 C 140 700, 360 560, 660 460",
  "M-40 700 C 160 520, 300 260, 600 80",
  "M-40 940 C 260 780, 420 660, 680 600",
  "M-40 640 C 120 460, 200 200, 480 -20",
];

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
        <div className="lg-aurora"><i /><i /><i /></div>
        <div className="lg-grid" />
        <svg className="lg-beams" viewBox="0 0 600 900" preserveAspectRatio="xMidYMid slice">
          <defs>
            <linearGradient id="lg-beam" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#7091ff" stopOpacity="0" />
              <stop offset=".5" stopColor="#9db4ff" />
              <stop offset="1" stopColor="#c4b5fd" stopOpacity="0" />
            </linearGradient>
          </defs>
          {BEAMS.map((d, i) => <path key={"t" + i} d={d} className="lg-track" />)}
          {BEAMS.map((d, i) => <path key={"b" + i} d={d} pathLength={1} className="lg-beam" style={{ animationDelay: `${i * -1.3}s`, animationDuration: `${6 + (i % 3) * 1.5}s` }} />)}
        </svg>
        <div className="lg-brand">
          <svg viewBox="0 0 32 32" width="26" height="26"><rect width="32" height="32" rx="7" fill="#3d63dd" /><g transform="translate(5.5 5.5) scale(.65)" fill="#fff" stroke="#fff" strokeWidth="2" strokeLinejoin="round"><path d="M28.5 3.5 3.5 13.5l9 4.5Z" /><path d="M28.5 3.5 14 19.5l4.5 9Z" /></g></svg>
          Outreach
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
