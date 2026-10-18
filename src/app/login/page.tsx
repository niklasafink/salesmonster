"use client";
import { useState } from "react";
import { Eye, EyeOff, ArrowRight, Loader2 } from "lucide-react";
import { LoginArt } from "@/components/login-art";
import { safeNext } from "@/lib/safe-next";

export default function Login() {
  const [email, setEmail] = useState(""), [pw, setPw] = useState(""), [show, setShow] = useState(false), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    const r = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: pw }) });
    if (r.ok) location.href = safeNext(location.search, location.origin);
    else { setErr((await r.json()).error || "Anmeldung fehlgeschlagen"); setBusy(false); }
  }
  return (
    <div className="login">
      <LoginArt />
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
