import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as AUTHORIZE, POST as AUTHORIZE_POST } from "@/app/api/oauth/authorize/route";
import { GET as PRM } from "@/app/.well-known/oauth-protected-resource/[[...path]]/route";
import { GET as ASM } from "@/app/.well-known/oauth-authorization-server/[[...path]]/route";
import { POST as REGISTER } from "@/app/api/oauth/register/route";
import { POST as TOKEN } from "@/app/api/oauth/token/route";
import { CALLBACK, authorizeCode, connectorTokens, fixtures, http } from "./helpers";

const fx = fixtures();
afterAll(() => fx.cleanup());

describe("OAuth-Metadaten", () => {
  it("Protected Resource nennt /api/mcp und das Portal als Authorization Server", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/api/mcp"]) {
      const r = await http(PRM, { path });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ resource: "http://localhost/api/mcp", authorization_servers: ["http://localhost"] });
    }
  });

  it("Authorization Server mit Endpunkten, PKCE S256 und öffentlichen Clients", async () => {
    const r = await http(ASM, { path: "/.well-known/oauth-authorization-server" });
    expect(await r.json()).toMatchObject({
      issuer: "http://localhost",
      authorization_endpoint: "http://localhost/api/oauth/authorize",
      token_endpoint: "http://localhost/api/oauth/token",
      registration_endpoint: "http://localhost/api/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  it("APP_URL bestimmt den Origin", async () => {
    process.env.APP_URL = "https://portal.example/";
    try {
      expect(await (await http(PRM, { path: "/.well-known/oauth-protected-resource" })).json())
        .toMatchObject({ resource: "https://portal.example/api/mcp", authorization_servers: ["https://portal.example"] });
    } finally { delete process.env.APP_URL; }
  });
});

const CB = "https://claude.ai/api/mcp/auth_callback";

describe("Registrierung", () => {
  it("nimmt claude.ai- und claude.com-Callback an, als öffentlicher Client", async () => {
    const r = await http(REGISTER, { json: { client_name: "Claude", redirect_uris: [CB, "https://claude.com/api/mcp/auth_callback"], token_endpoint_auth_method: "none" } });
    expect(r.status).toBe(201);
    const c = await r.json();
    expect(c).toMatchObject({ client_name: "Claude", redirect_uris: [CB, "https://claude.com/api/mcp/auth_callback"], token_endpoint_auth_method: "none" });
    expect(c.client_id).toEqual(expect.any(String));
    expect(c.client_secret).toBeUndefined();
  });

  it("lehnt fremde Redirect-URIs ab", async () => {
    for (const uris of [["https://evil.example/cb"], [CB, "https://evil.example/cb"], []]) {
      const r = await http(REGISTER, { json: { client_name: "X", redirect_uris: uris } });
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe("invalid_redirect_uri");
    }
  });

  it("MCP_REDIRECTS erweitert die Liste", async () => {
    process.env.MCP_REDIRECTS = "http://localhost:6274/oauth/callback, https://x.example/cb";
    try { expect((await http(REGISTER, { json: { redirect_uris: ["https://x.example/cb"] } })).status).toBe(201); }
    finally { delete process.env.MCP_REDIRECTS; }
  });
});

const pkce = () => { const v = randomBytes(32).toString("base64url"); return { v, c: createHash("sha256").update(v).digest("base64url") }; };
async function client() { return (await (await http(REGISTER, { json: { client_name: "Claude", redirect_uris: [CB] } })).json()).client_id as string; }
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

describe("Authorize", () => {
  let cid: string, me: { id: number };
  const { c } = pkce();
  const params = () => ({ response_type: "code", client_id: cid, redirect_uri: CB, code_challenge: c, code_challenge_method: "S256", state: "st-1", resource: "http://localhost/api/mcp" });
  beforeAll(async () => { cid = await client(); me = await fx.user(); });

  it("ohne Session → Login mit Rücksprung", async () => {
    const path = `/api/oauth/authorize?${q(params())}`;
    const r = await http(AUTHORIZE, { path });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe(path);
  });

  it("mit Session → Freigabeseite mit denselben Parametern", async () => {
    const r = await http(AUTHORIZE, { as: me, path: `/api/oauth/authorize?${q(params())}` });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.pathname).toBe("/freigabe");
    expect(Object.fromEntries(loc.searchParams)).toEqual(params());
  });

  it("unbekannter Client oder fremde Redirect-URI → 400 ohne Weiterleitung", async () => {
    for (const p of [{ ...params(), client_id: "x" }, { ...params(), redirect_uri: "https://claude.com/api/mcp/auth_callback" }]) {
      const r = await http(AUTHORIZE, { as: me, path: `/api/oauth/authorize?${q(p)}` });
      expect(r.status).toBe(400);
      expect(r.headers.get("location")).toBeNull();
    }
  });

  it("ohne PKCE S256 → Fehler an den Client", async () => {
    for (const p of [{ ...params(), code_challenge_method: "plain" }, { ...params(), code_challenge: "" }]) {
      const loc = new URL((await http(AUTHORIZE, { as: me, path: `/api/oauth/authorize?${q(p)}` })).headers.get("location")!);
      expect(`${loc.origin}${loc.pathname}`).toBe(CB);
      expect(loc.searchParams.get("error")).toBe("invalid_request");
      expect(loc.searchParams.get("state")).toBe("st-1");
    }
  });

  it("Erlauben → Redirect mit Code, state und iss", async () => {
    const r = await http(AUTHORIZE_POST, { as: me, form: { ...params(), allow: "1" } });
    expect(r.status).toBe(303);
    const loc = new URL(r.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(CB);
    expect(loc.searchParams.get("code")).toEqual(expect.any(String));
    expect(loc.searchParams.get("state")).toBe("st-1");
    expect(loc.searchParams.get("iss")).toBe("http://localhost");
  });

  it("Abbrechen → access_denied", async () => {
    const loc = new URL((await http(AUTHORIZE_POST, { as: me, form: params() })).headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("code")).toBeNull();
  });

  it("Erlauben ohne Session → Login", async () => {
    const r = await http(AUTHORIZE_POST, { form: { ...params(), allow: "1" } });
    expect(new URL(r.headers.get("location")!).pathname).toBe("/login");
  });
});

describe("Token", () => {
  let me: { id: number };
  beforeAll(async () => { me = await fx.user(); });
  const exchange = (a: { code: string; client_id: string }, code_verifier: string) =>
    http(TOKEN, { form: { grant_type: "authorization_code", code: a.code, client_id: a.client_id, redirect_uri: CALLBACK, code_verifier } });

  it("falscher PKCE-Verifier → invalid_grant", async () => {
    const a = await authorizeCode(me);
    const r = await exchange(a, pkce().v);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_grant");
  });

  it("richtiger Verifier → Access und Refresh Token, Code nur einmal", async () => {
    const a = await authorizeCode(me);
    const r = await exchange(a, a.verifier);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toMatchObject({ access_token: expect.any(String), refresh_token: expect.any(String), token_type: "Bearer", expires_in: 3600 });
    expect((await exchange(a, a.verifier)).status).toBe(400);
  });

  it("Refresh rotiert, der alte Refresh-Token gilt danach nicht mehr", async () => {
    const t = await connectorTokens(me);
    const r = await http(TOKEN, { form: { grant_type: "refresh_token", refresh_token: t.refresh_token } });
    expect(r.status).toBe(200);
    const n = await r.json();
    expect(n.refresh_token).not.toBe(t.refresh_token);
    expect(n.access_token).toEqual(expect.any(String));
    const again = await http(TOKEN, { form: { grant_type: "refresh_token", refresh_token: t.refresh_token } });
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe("invalid_grant");
    expect((await http(TOKEN, { form: { grant_type: "refresh_token", refresh_token: n.refresh_token } })).status).toBe(200);
  });

  it("unbekannter grant_type", async () => {
    expect((await (await http(TOKEN, { form: { grant_type: "password" } })).json()).error).toBe("unsupported_grant_type");
  });
});
