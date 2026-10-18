import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/mcp/route";
import { DELETE as REVOKE, GET as GRANTS } from "@/app/api/oauth/grants/route";
import { connectorTokens, fixtures, http, mcp } from "./helpers";

const fx = fixtures();
let me: { id: number }, other: { id: number }, mine: { slug: string; name: string }[], theirs: { slug: string };

beforeAll(async () => {
  me = await fx.user(); other = await fx.user();
  mine = [await fx.tenant(me), await fx.tenant(me)];
  theirs = await fx.tenant(other);
});
afterAll(() => fx.cleanup());

const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const accept = { accept: "application/json, text/event-stream" };

describe("MCP-Endpunkt", () => {
  it("ohne Token 401 mit WWW-Authenticate auf die Resource-Metadaten", async () => {
    const r = await http(POST, { path: "/api/mcp", json: rpc, headers: accept });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/^Bearer .*resource_metadata="http:\/\/localhost\/\.well-known\/oauth-protected-resource\/api\/mcp"/);
  });

  it("ungültiger Token 401", async () => {
    const r = await http(POST, { path: "/api/mcp", json: rpc, headers: { ...accept, authorization: "Bearer abc.def.ghi" } });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/invalid_token/);
  });

  it("Refresh-Token ist kein Access Token", async () => {
    const t = await connectorTokens(me);
    expect((await http(POST, { path: "/api/mcp", json: rpc, headers: { ...accept, authorization: `Bearer ${t.refresh_token}` } })).status).toBe(401);
  });

  it("tenants_list liefert nur eigene Mandanten", async () => {
    const c = await mcp((await connectorTokens(me)).access_token);
    expect((await c.listTools()).tools.map(t => t.name)).toContain("tenants_list");
    expect(c.getInstructions()).toMatch(/Schritt für Schritt/);
    const list = await c.tool<{ slug: string; name: string; domain: string }[]>("tenants_list");
    expect(list.map(t => t.slug).sort()).toEqual(mine.map(t => t.slug).sort());
    expect(list[0]).toEqual({ slug: expect.any(String), name: expect.any(String), domain: "example.test", hubspot: false, sendpilot: false, mailbox: null, ai: null });
    expect(list.map(t => t.slug)).not.toContain(theirs.slug);
    await c.close();
  });

  it("2025er Streamable HTTP (wie claude.ai) bekommt den Nutzer ebenso", async () => {
    const h = { ...accept, authorization: `Bearer ${(await connectorTokens(me)).access_token}` };
    const init = await http(POST, { path: "/api/mcp", headers: h, json: { jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } } } });
    expect(init.status).toBe(200);
    const r = await http(POST, { path: "/api/mcp", headers: { ...h, "mcp-protocol-version": "2025-06-18" },
      json: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tenants_list", arguments: {} } } });
    const body = await r.text(), msg = JSON.parse(body.startsWith("{") ? body : body.split("\n").find(l => l.startsWith("data:"))!.slice(5));
    expect(JSON.parse(msg.result.content[0].text).map((t: { slug: string }) => t.slug).sort()).toEqual(mine.map(t => t.slug).sort());
  });

  it("Trennen widerruft den Grant, danach 401", async () => {
    const t = await connectorTokens(me);
    const { grants } = await (await http(GRANTS, { as: me, path: "/api/oauth/grants" })).json();
    expect(grants.length).toBeGreaterThan(0);
    expect(grants[0]).toMatchObject({ id: expect.any(Number), clientName: "Claude" });
    for (const g of grants) expect((await http(REVOKE, { as: me, method: "DELETE", path: `/api/oauth/grants?id=${g.id}` })).status).toBe(200);
    expect((await http(POST, { path: "/api/mcp", json: rpc, headers: { ...accept, authorization: `Bearer ${t.access_token}` } })).status).toBe(401);
    expect((await (await http(GRANTS, { as: me, path: "/api/oauth/grants" })).json()).grants).toEqual([]);
  });

  it("fremde Grants lassen sich nicht trennen", async () => {
    const t = await connectorTokens(other);
    const { grants } = await (await http(GRANTS, { as: other, path: "/api/oauth/grants" })).json();
    expect((await http(REVOKE, { as: me, method: "DELETE", path: `/api/oauth/grants?id=${grants[0].id}` })).status).toBe(404);
    const c = await mcp(t.access_token);
    expect((await c.tool<{ slug: string }[]>("tenants_list")).map(x => x.slug)).toEqual([theirs.slug]);
    await c.close();
  });
});
