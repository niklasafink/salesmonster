/* The portal is OAuth authorization server and MCP resource server in one (spec: Auth).
   client_id, code and access token are signed JWTs; only grants with the hashed refresh token are stored. */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { getPublicOrigin } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { db, oauthGrants } from "@/db";

const key = () => new TextEncoder().encode(`oauth:${process.env.APP_SECRET}`);
/* typ keeps client ids, codes and access tokens from standing in for each other */
async function sign(typ: string, claims: JWTPayload, exp?: string, aud?: string) {
  const j = new SignJWT({ ...claims, typ }).setProtectedHeader({ alg: "HS256" }).setIssuedAt();
  if (exp) j.setExpirationTime(exp);
  if (aud) j.setAudience(aud);
  return j.sign(key());
}
async function verify<T>(typ: string, token: string | null | undefined, aud?: string): Promise<(JWTPayload & T) | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), aud ? { audience: aud } : {});
    return payload.typ === typ ? payload as JWTPayload & T : null;
  } catch { return null; }
}
const sha = (s: string) => createHash("sha256").update(s).digest("base64url");

export const ACCESS_TTL = 3600;
const REFRESH_DAYS = 90;

export const origin = (req: Request) => (process.env.APP_URL || getPublicOrigin(req)).replace(/\/+$/, "");
export const resource = (req: Request) => `${origin(req)}/api/mcp`;

export function authServerMetadata(req: Request) {
  const o = origin(req);
  return {
    issuer: o,
    authorization_endpoint: `${o}/api/oauth/authorize`,
    token_endpoint: `${o}/api/oauth/token`,
    registration_endpoint: `${o}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  };
}

export const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "*", "Access-Control-Max-Age": "86400" };

export const redirects = () => ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback",
  ...(process.env.MCP_REDIRECTS || "").split(",").map(s => s.trim()).filter(Boolean)];

export type Client = { ru: string[]; n: string };
export const signClient = (c: Client) => sign("client", c);

/* Authorize parameters. fatal: client or redirect unknown, never redirect there; err: report to the client's redirect */
export async function authRequest(p: URLSearchParams) {
  const cid = p.get("client_id") || "", client = await verify<Client>("client", cid);
  const ru = p.get("redirect_uri") || (client?.ru.length === 1 ? client.ru[0] : "");
  if (!client || !client.ru.includes(ru) || !redirects().includes(ru)) return { fatal: "Unbekannter Client oder Redirect-URI" } as const;
  const cc = p.get("code_challenge") || "", state = p.get("state");
  const err = p.get("response_type") !== "code" ? "unsupported_response_type" : p.get("code_challenge_method") !== "S256" || !cc ? "invalid_request" : null;
  return { cid, name: client.n, ru, cc, state, err };
}

export function back(ru: string, q: Record<string, string | null>) {
  const u = new URL(ru);
  for (const [k, v] of Object.entries(q)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

/* Erlauben: the grant exists from here on, but only counts as connected once its code is exchanged */
export async function issueCode(uid: number, a: { cid: string; name: string; ru: string; cc: string }) {
  const [g] = await db.insert(oauthGrants).values({ userId: uid, clientName: a.name }).returning({ id: oauthGrants.id });
  return sign("code", { uid, gid: g.id, cid: a.cid, ru: a.ru, cc: a.cc }, "5m");
}

type Tokens = { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string };
async function tokens(req: Request, uid: number, gid: number, refresh: string): Promise<Tokens> {
  return { access_token: await sign("at", { uid, gid }, `${ACCESS_TTL}s`, resource(req)), token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh };
}

export async function exchangeCode(req: Request, p: URLSearchParams): Promise<Tokens | null> {
  const c = await verify<{ uid: number; gid: number; cid: string; ru: string; cc: string }>("code", p.get("code"));
  const v = p.get("code_verifier") || "";
  if (!c || c.cid !== p.get("client_id") || c.ru !== (p.get("redirect_uri") || c.ru) || !v || sha(v) !== c.cc) return null;
  const rt = randomBytes(32).toString("base64url");
  const [g] = await db.update(oauthGrants).set({ refreshHash: sha(rt), lastUsedAt: new Date() })
    .where(and(eq(oauthGrants.id, c.gid), eq(oauthGrants.userId, c.uid), isNull(oauthGrants.refreshHash), isNull(oauthGrants.revokedAt))).returning();
  return g ? tokens(req, g.userId, g.id, rt) : null;
}

/* Rotates: the presented refresh token stops working, the new one lives another 90 days */
export async function refresh(req: Request, p: URLSearchParams): Promise<Tokens | null> {
  const old = p.get("refresh_token");
  if (!old) return null;
  const [g] = await db.select().from(oauthGrants).where(and(eq(oauthGrants.refreshHash, sha(old)), isNull(oauthGrants.revokedAt)));
  if (!g || +(g.lastUsedAt ?? g.createdAt) < Date.now() - REFRESH_DAYS * 864e5) return null;
  const rt = randomBytes(32).toString("base64url");
  const [n] = await db.update(oauthGrants).set({ refreshHash: sha(rt), lastUsedAt: new Date() })
    .where(and(eq(oauthGrants.id, g.id), eq(oauthGrants.refreshHash, sha(old)))).returning();
  return n ? tokens(req, n.userId, n.id, rt) : null;
}

/* verifyToken for withMcpAuth: a revoked grant fails at once, not after the access token expires */
export async function verifyAccess(req: Request, token?: string): Promise<AuthInfo | undefined> {
  const t = await verify<{ uid: number; gid: number }>("at", token, resource(req));
  if (!t || !token) return;
  const [g] = await db.select({ id: oauthGrants.id }).from(oauthGrants)
    .where(and(eq(oauthGrants.id, t.gid), eq(oauthGrants.userId, t.uid), isNull(oauthGrants.revokedAt)));
  if (!g) return;
  return { token, clientId: String(t.gid), scopes: [], expiresAt: t.exp, extra: { userId: t.uid, grantId: t.gid } };
}
