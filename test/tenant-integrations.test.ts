import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PATCH } from "@/app/api/tenants/[slug]/route";
import { aiFor } from "@/lib/ai";
import { setInteg } from "@/lib/integrations";
import { call, connectorTokens, fixtures, mcp } from "./helpers";

const fx = fixtures();
let me: { id: number }, vh: { id: number; slug: string }, chetti: { id: number; slug: string };

beforeAll(async () => {
  me = await fx.user();
  vh = await fx.tenant(me); chetti = await fx.tenant(me);
  /* AI keys once for the account, HubSpot only for one tenant */
  await setInteg(vh.id, "claude", me.id, { key: "sk-ant-test" }, "");
  await setInteg(vh.id, "openrouter", me.id, { key: "sk-or-test", model: "anthropic/claude-sonnet-5.5" }, "");
  await setInteg(vh.id, "hubspot", null, { token: "pat-test" }, "Portal 1");
});
afterAll(() => fx.cleanup());

const patch = (slug: string, ai: string | null) => call(PATCH, { as: me, method: "PATCH", body: { settings: { ai } }, ctx: { params: Promise.resolve({ slug }) } });

describe("Integrationen je Mandant", () => {
  it("jeder Mandant wählt seine KI aus den Schlüsseln des Accounts, ohne neu zu verbinden", async () => {
    expect(await aiFor(chetti.id, me.id)).toMatchObject({ provider: "anthropic" });
    expect((await patch(chetti.slug, "openrouter:google/gemini-3.8-flash")).status).toBe(200);
    expect(await aiFor(chetti.id, me.id)).toMatchObject({ provider: "openrouter", key: "sk-or-test", model: "google/gemini-3.8-flash" });
    expect(await aiFor(vh.id, me.id)).toMatchObject({ provider: "anthropic" });
    expect((await patch(chetti.slug, null)).status).toBe(200);
    expect(await aiFor(chetti.id, me.id)).toMatchObject({ provider: "anthropic" });
  });

  it("Claude-Modell je Mandant, alte Wahl bleibt Sonnet", async () => {
    expect((await patch(chetti.slug, "claude:claude-opus-5-5")).status).toBe(200);
    expect(await aiFor(chetti.id, me.id)).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5" });
    expect((await patch(chetti.slug, "claude")).status).toBe(200);
    expect(await aiFor(chetti.id, me.id)).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect((await patch(chetti.slug, "claude:claude-gibt-es-nicht")).status).toBe(400);
    await patch(chetti.slug, null);
  });

  it("unbekannte KI wird abgelehnt", async () => {
    expect((await patch(vh.slug, "openrouter:gibt-es-nicht")).status).toBe(400);
  });

  it("MCP zeigt je Mandant HubSpot und KI getrennt", async () => {
    await patch(chetti.slug, "openrouter:google/gemini-3.8-flash");
    const c = await mcp((await connectorTokens(me)).access_token);
    const list = await c.tool<{ slug: string; hubspot: boolean; ai: string | null }[]>("tenants_list");
    expect(list.find(t => t.slug === vh.slug)).toMatchObject({ hubspot: true, ai: "Claude Sonnet 5.5" });
    expect(list.find(t => t.slug === chetti.slug)).toMatchObject({ hubspot: false, ai: "Gemini 3.8 Flash über OpenRouter" });
    expect((await c.listTools()).tools.map(t => t.name)).toEqual(expect.arrayContaining(["mail_sync_run", "mail_sync_status"]));
  });
});
