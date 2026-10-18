import { CORS, exchangeCode, refresh } from "@/lib/oauth";

const out = (body: object, status = 200) => Response.json(body, { status, headers: { ...CORS, "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  const raw = await req.text();
  let p = new URLSearchParams(raw);
  if ((req.headers.get("content-type") || "").includes("json")) try { p = new URLSearchParams(JSON.parse(raw)); } catch { p = new URLSearchParams(); }
  const g = p.get("grant_type");
  if (g !== "authorization_code" && g !== "refresh_token") return out({ error: "unsupported_grant_type" }, 400);
  const t = g === "authorization_code" ? await exchangeCode(req, p) : await refresh(req, p);
  return t ? out(t) : out({ error: "invalid_grant" }, 400);
}

export const OPTIONS = () => new Response(null, { status: 204, headers: CORS });
