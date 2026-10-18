import { jwtVerify } from "jose";
import { tenantBySlug } from "@/lib/api";
import { setInteg } from "@/lib/integrations";
import { msToken, msVerifier, stateKey } from "@/lib/mail";
import { startSync } from "@/lib/mail-sync";

export async function GET(req: Request) {
  const u = new URL(req.url), back = (msg: string) => Response.redirect(new URL(`/?msg=${encodeURIComponent(msg)}#einstellungen`, req.url).toString(), 302);
  try {
    const { payload } = await jwtVerify(u.searchParams.get("state") || "", stateKey());
    const code = u.searchParams.get("code");
    if (!code) return back(u.searchParams.get("error_description") || "Anmeldung abgebrochen");
    const tok = await msToken({ grant_type: "authorization_code", code, code_verifier: msVerifier(String(payload.n || "")), redirect_uri: new URL("/api/integrations/microsoft/callback", req.url).toString() });
    const me = await (await fetch("https://graph.microsoft.com/v1.0/me", { headers: { authorization: `Bearer ${tok.access_token}` } })).json();
    const email = me.mail || me.userPrincipalName || "";
    const t = await tenantBySlug(String(payload.t), { id: Number(payload.uid) });
    await setInteg(t.id, "outlook", Number(payload.uid), { access: tok.access_token, refresh: tok.refresh_token, exp: Date.now() + tok.expires_in * 1000, email }, email);
    await startSync(t.id, Number(payload.uid), "outlook");
    return back("Microsoft 365 verbunden");
  } catch (e) {
    return back(e instanceof Error ? e.message : "Anmeldung fehlgeschlagen");
  }
}
