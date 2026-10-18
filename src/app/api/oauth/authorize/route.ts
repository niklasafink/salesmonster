import { cookies } from "next/headers";
import { getPublicOrigin } from "mcp-handler";
import { authParams, authRequest, back, issueCode, origin } from "@/lib/oauth";
import { COOKIE, readSession } from "@/lib/session";

const uid = async () => readSession((await cookies()).get(COOKIE)?.value);
const toLogin = (req: Request, p: URLSearchParams, status: number) =>
  Response.redirect(`${origin(req)}/login?next=${encodeURIComponent(`/api/oauth/authorize?${p}`)}`, status);

/* Checks the request, then sends the user through login to the Freigabe page */
export async function GET(req: Request) {
  const p = authParams(new URL(req.url).searchParams), a = await authRequest(p);
  if ("fatal" in a) return new Response(a.fatal, { status: 400 });
  if (a.err) return Response.redirect(back(a.ru, { error: a.err, state: a.state, iss: origin(req) }), 302);
  if (!await uid()) return toLogin(req, p, 302);
  return Response.redirect(`${origin(req)}/freigabe?${p}`, 302);
}

/* Form post from the Freigabe page: only a single allow=1 (the Erlauben button) grants, anything else is Abbrechen */
export async function POST(req: Request) {
  const o = req.headers.get("origin");
  if (o && o !== origin(req) && o !== getPublicOrigin(req)) return new Response("Fremder Ursprung", { status: 403 });
  const f = new URLSearchParams(await req.text()), allow = f.getAll("allow").join() === "1", p = authParams(f);
  const a = await authRequest(p);
  if ("fatal" in a) return new Response(a.fatal, { status: 400 });
  const iss = origin(req);
  if (a.err) return Response.redirect(back(a.ru, { error: a.err, state: a.state, iss }), 303);
  const u = await uid();
  if (!u) return toLogin(req, p, 303);
  if (!allow) return Response.redirect(back(a.ru, { error: "access_denied", state: a.state, iss }), 303);
  return Response.redirect(back(a.ru, { code: await issueCode(u, a), state: a.state, iss }), 303);
}
