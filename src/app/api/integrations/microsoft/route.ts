import { SignJWT } from "jose";
import { currentUser, fail, qp, tenantBySlug } from "@/lib/api";
import { MS_SCOPES, msConfigured, stateKey } from "@/lib/mail";

export async function GET(req: Request) {
  try {
    const u = await currentUser();
    const t = await tenantBySlug(qp(req, "t"), u);
    const back = new URL("/#einstellungen", req.url);
    if (!msConfigured()) return Response.redirect(`${back}`, 302);
    const state = await new SignJWT({ uid: u.id, t: t.slug }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("15m").sign(stateKey());
    const url = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    url.search = new URLSearchParams({ client_id: process.env.MS_CLIENT_ID!, response_type: "code", response_mode: "query",
      redirect_uri: new URL("/api/integrations/microsoft/callback", req.url).toString(), scope: MS_SCOPES, state, prompt: "select_account" }).toString();
    return Response.redirect(url.toString(), 302);
  } catch (e) { return fail(e); }
}
