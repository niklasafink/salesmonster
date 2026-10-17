"use client";
import { useState } from "react";

export default function Login() {
  const [email, setEmail] = useState(""), [pw, setPw] = useState(""), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    const r = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: pw }) });
    if (r.ok) location.href = "/";
    else { setErr((await r.json()).error || "Anmeldung fehlgeschlagen"); setBusy(false); }
  }
  return (
    <div className="login">
      <form className="dlg" onSubmit={submit}>
        <div className="dlg-h">Anmelden</div>
        <label className="fld"><span>E-Mail</span><input className="inp" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} autoFocus /></label>
        <label className="fld"><span>Passwort</span><input className="inp" type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} /></label>
        {err && <div className="warn">{err}</div>}
        <button className="btn pri wide" disabled={busy}>Anmelden</button>
      </form>
    </div>
  );
}
