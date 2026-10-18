"use client";
import { useEffect, useState } from "react";
import { Eye, EyeOff, ArrowRight, Loader2 } from "lucide-react";
import { LoginArt } from "@/components/login-art";
import { safeNext } from "@/lib/safe-next";

export default function Registrieren() {
  const [name, setName] = useState(""), [email, setEmail] = useState(""), [pw, setPw] = useState(""), [show, setShow] = useState(false), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => setQ(location.search), []);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    const invite = new URLSearchParams(location.search).get("einladung") || undefined;
    const r = await fetch("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email, password: pw, invite }) });
    if (r.ok) location.href = safeNext(location.search, location.origin);
    else { setErr((await r.json()).error || "Registrierung fehlgeschlagen"); setBusy(false); }
  }
  return (
    <div className="login">
      <LoginArt />
      <main className="lg-side">
        <form className="lg-form" onSubmit={submit}>
          <h1>Konto erstellen</h1>
          <label className="fld"><span>Name</span><input className="inp" autoComplete="name" value={name} onChange={e => setName(e.target.value)} autoFocus required /></label>
          <label className="fld"><span>E-Mail</span><input className="inp" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required /></label>
          <label className="fld"><span>Passwort</span>
            <span className="lg-pw">
              <input className="inp" type={show ? "text" : "password"} autoComplete="new-password" minLength={10} value={pw} onChange={e => setPw(e.target.value)} required />
              <button type="button" onClick={() => setShow(s => !s)} aria-label={show ? "Passwort verbergen" : "Passwort anzeigen"}>{show ? <EyeOff /> : <Eye />}</button>
            </span>
          </label>
          {err && <div className="warn">{err}</div>}
          <button className="btn pri wide lg-go" disabled={busy}>{busy ? <Loader2 className="spin" /> : <>Konto erstellen<ArrowRight /></>}</button>
          <a className="lg-alt" href={"/login" + q}>Anmelden</a>
        </form>
      </main>
    </div>
  );
}
