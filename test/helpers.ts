import { createHash, randomBytes } from "node:crypto";
import { vi } from "vitest";
import { inArray } from "drizzle-orm";
import { db, members, tenants, users } from "@/db";
import { COOKIE, signSession } from "@/lib/session";
import { reqStore } from "./req";

/* Throwaway users/tenants on the test branch; cleanup() deletes them (leads etc. go by cascade) */
export function fixtures() {
  const uids: number[] = [], tids: number[] = [];
  const tag = () => `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    async user() {
      const t = tag();
      const [u] = await db.insert(users).values({ email: `${t}@example.test`, name: "Test Nutzer", short: "TN", passwordHash: "-" }).returning();
      uids.push(u.id);
      return u;
    },
    async tenant(owner: { id: number }) {
      const t = tag();
      const [row] = await db.insert(tenants).values({ slug: t, name: `Test ${t}`, initials: "TT", domain: "example.test",
        settings: { prompt: "", leadsPerDay: 10, cooldownDays: 30 } }).returning();
      tids.push(row.id);
      await db.insert(members).values({ tenantId: row.id, userId: owner.id });
      return row;
    },
    async cleanup() {
      if (tids.length) await db.delete(tenants).where(inArray(tenants.id, tids.splice(0)));
      if (uids.length) await db.delete(users).where(inArray(users.id, uids.splice(0)));
    },
  };
}

type Handler<C> = (req: Request, ctx: C) => Response | Promise<Response>;

/* Calls a route handler like Next would: a Request carrying the session cookie of `as` */
export async function call<C = unknown>(handler: Handler<C>, opts: { as?: { id: number }; method?: string; path?: string; body?: unknown; ctx?: C } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.as) headers.set("cookie", `${COOKIE}=${await signSession(opts.as.id)}`);
  const req = new Request(`http://localhost${opts.path || "/"}`, { method: opts.method || (opts.body ? "POST" : "GET"), headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  const res = await reqStore.run(req, () => handler(req, opts.ctx as C));
  return { status: res.status, json: await res.json() };
}

/* Raw call for OAuth/MCP routes: keeps the Response (redirects, headers), sends form or JSON bodies */
export async function http<C = unknown>(handler: Handler<C>, opts: { as?: { id: number }; method?: string; path?: string; form?: Record<string, string> | [string, string][]; json?: unknown;
  headers?: Record<string, string>; ctx?: C } = {}) {
  const headers = new Headers(opts.headers);
  if (opts.as) headers.set("cookie", `${COOKIE}=${await signSession(opts.as.id)}`);
  let body: string | undefined;
  if (opts.form) { headers.set("content-type", "application/x-www-form-urlencoded"); body = new URLSearchParams(opts.form).toString(); }
  else if (opts.json !== undefined) { headers.set("content-type", "application/json"); body = JSON.stringify(opts.json); }
  const req = new Request(`http://localhost${opts.path || "/"}`, { method: opts.method || (body ? "POST" : "GET"), headers, body });
  return reqStore.run(req, () => handler(req, opts.ctx as C));
}

export const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/* Claude's side of the OAuth flow up to the code: register, Erlauben as `as` */
export async function authorizeCode(as: { id: number }) {
  const { POST: register } = await import("@/app/api/oauth/register/route");
  const { POST: authorize } = await import("@/app/api/oauth/authorize/route");
  const client_id = (await (await http(register, { json: { client_name: "Claude", redirect_uris: [CALLBACK] } })).json()).client_id as string;
  const verifier = randomBytes(32).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url");
  const r = await http(authorize, { as, form: { response_type: "code", client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "s", allow: "1" } });
  return { client_id, verifier, code: new URL(r.headers.get("location")!).searchParams.get("code")! };
}

/* Full connector login: access and refresh token of a fresh grant for `as` */
export async function connectorTokens(as: { id: number }) {
  const { POST: token } = await import("@/app/api/oauth/token/route");
  const { client_id, verifier, code } = await authorizeCode(as);
  const r = await http(token, { form: { grant_type: "authorization_code", code, client_id, redirect_uri: CALLBACK, code_verifier: verifier } });
  return await r.json() as { access_token: string; refresh_token: string; expires_in: number; token_type: string };
}

/* MCP SDK client talking to the /api/mcp route handler in-process; tool() returns the parsed JSON result */
export async function mcp(token: string) {
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const route = await import("@/app/api/mcp/route");
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
    fetch: (url, init) => { const req = new Request(url, init); return (req.method === "GET" ? route.GET : req.method === "DELETE" ? route.DELETE : route.POST)(req); },
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return Object.assign(client, {
    async tool<T = unknown>(name: string, args: Record<string, unknown> = {}) {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content as { type: string; text?: string }[]).find(c => c.type === "text")?.text ?? "";
      if (r.isError) throw new Error(text);
      return JSON.parse(text) as T;
    },
  });
}

/* OpenRouter at the network edge: Jev decisions and chat completions answer from the given functions, everything else (Neon) passes through.
   Returns the requests seen, newest last. Undo with vi.unstubAllGlobals(). */
export function fakeOpenRouter(opts: { jev?: (state: string, questions: Record<string, unknown>) => Record<string, unknown>; chat?: (body: { model: string; messages: { role: string; content: string }[] }) => string }) {
  const real = globalThis.fetch, seen: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!u.startsWith("https://openrouter.ai/")) return real(url, init);
    const body = JSON.parse(String(init?.body || "{}"));
    seen.push({ url: u, body });
    if (u.endsWith("/alpha/decisions") && opts.jev) return Response.json({ answers: opts.jev(body.state, body.questions) });
    if (u.endsWith("/chat/completions") && opts.chat) return Response.json({ choices: [{ message: { content: opts.chat(body) } }] });
    return new Response("{}", { status: 500 });
  });
  return seen;
}

/* Jev's answer shape for the mail questions in lib/jev.ts */
export const jevMail = (reply: number, specific = 1, easyAsk = 1) => ({
  reply: { type: "score", score: reply }, specific: { type: "noul", noul: specific }, easyAsk: { type: "noul", noul: easyAsk }, weakness: { type: "choice", choice: "none" },
});
