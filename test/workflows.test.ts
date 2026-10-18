import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as list from "@/app/api/workflows/route";
import * as one from "@/app/api/workflows/[id]/route";
import * as runs from "@/app/api/workflows/[id]/runs/route";
import * as grants from "@/app/api/oauth/grants/route";
import { call, fixtures } from "./helpers";

const fx = fixtures();
let me: { id: number }, t: { id: number; slug: string }, theirs: { slug: string }, other: { id: number };
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

beforeAll(async () => {
  me = await fx.user(); t = await fx.tenant(me);
  other = await fx.user(); theirs = await fx.tenant(other);
});
afterAll(async () => { await fx.cleanup(); });

type Wf = { id: number; name: string; instructions: string; writes: string[]; active: boolean; lastRun: unknown };

describe("Workflows im Portal", () => {
  it("anlegen, neueste oben, nur bekannte Ergebnisse", async () => {
    const a = await call(list.POST, { as: me, body: { t: t.slug, name: " Recherche ", instructions: "Finde Firmen.", writes: ["leads_add", "quatsch"] } });
    expect(a.status).toBe(200);
    await call(list.POST, { as: me, body: { t: t.slug, name: "Anreichern", instructions: "", writes: ["leads_update", "report"] } });
    const { json } = await call(list.GET, { as: me, path: `/api/workflows?t=${t.slug}` });
    expect(json.rows.map((w: Wf) => w.name)).toEqual(["Anreichern", "Recherche"]);
    expect(json.rows[1]).toMatchObject({ id: a.json.id, name: "Recherche", instructions: "Finde Firmen.", writes: ["leads_add"], active: true, lastRun: null });
  });

  it("ohne Namen abgelehnt, fremder Mandant nicht gefunden", async () => {
    expect((await call(list.POST, { as: me, body: { t: t.slug, name: " ", writes: [] } })).status).toBe(400);
    expect((await call(list.POST, { as: me, body: { t: theirs.slug, name: "X", writes: [] } })).status).toBe(404);
    expect((await call(list.GET, { as: me, path: `/api/workflows?t=${theirs.slug}` })).status).toBe(404);
  });

  it("bearbeiten, deaktivieren, löschen; fremde nicht", async () => {
    const { json: { id } } = await call(list.POST, { as: me, body: { t: t.slug, name: "Alt", instructions: "a", writes: [] } });
    expect((await call(one.PUT, { as: me, method: "PUT", body: { name: "Neu", instructions: "b", writes: ["templates"], active: false }, ctx: ctx(id) })).status).toBe(200);
    let rows = (await call(list.GET, { as: me, path: `/api/workflows?t=${t.slug}` })).json.rows as Wf[];
    expect(rows.find(w => w.id === id)).toMatchObject({ name: "Neu", instructions: "b", writes: ["templates"], active: false });
    expect((await call(one.PUT, { as: other, method: "PUT", body: { name: "Hack" }, ctx: ctx(id) })).status).toBe(404);
    expect((await call(one.DELETE, { as: other, method: "DELETE", ctx: ctx(id) })).status).toBe(404);
    expect((await call(one.DELETE, { as: me, method: "DELETE", ctx: ctx(id) })).status).toBe(200);
    rows = (await call(list.GET, { as: me, path: `/api/workflows?t=${t.slug}` })).json.rows;
    expect(rows.some(w => w.id === id)).toBe(false);
  });
});

describe("IDs", () => {
  it("keine Zahl → 404 statt 500", async () => {
    const bad = { params: Promise.resolve({ id: "abc" }) };
    expect((await call(one.PUT, { as: me, method: "PUT", body: { name: "x" }, ctx: bad })).status).toBe(404);
    expect((await call(one.DELETE, { as: me, method: "DELETE", ctx: bad })).status).toBe(404);
    expect((await call(runs.GET, { as: me, ctx: bad })).status).toBe(404);
    expect((await call(grants.DELETE, { as: me, method: "DELETE", path: "/api/oauth/grants?id=abc" })).status).toBe(404);
  });
});
