import { CORS, redirects, signClient } from "@/lib/oauth";

/* RFC 7591. Only public clients with allowlisted callbacks; the client_id carries the redirects */
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({})) as { redirect_uris?: unknown; client_name?: unknown };
  const ru = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [], ok = redirects();
  if (!ru.length || ru.some(u => !ok.includes(u)))
    return Response.json({ error: "invalid_redirect_uri", error_description: "Redirect-URI nicht erlaubt" }, { status: 400, headers: CORS });
  const n = String(b.client_name || "Claude").slice(0, 80);
  return Response.json({ client_id: await signClient({ ru, n }), client_id_issued_at: Math.floor(Date.now() / 1000), client_name: n, redirect_uris: ru,
    token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, { status: 201, headers: CORS });
}

export const OPTIONS = () => new Response(null, { status: 204, headers: CORS });
