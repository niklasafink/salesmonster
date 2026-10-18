import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as list from "@/app/api/workflows/route";
import * as runs from "@/app/api/workflows/[id]/runs/route";
import { GET as leadsGet } from "@/app/api/leads/route";
import { db, templates, tenants, workflowRuns } from "@/db";
import { call, connectorTokens, fixtures, mcp } from "./helpers";

const fx = fixtures();
let me: { id: number; name: string }, them: { id: number; name: string }, t: { id: number; slug: string; name: string }, theirs: { id: number; slug: string }, c: Awaited<ReturnType<typeof mcp>>;
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

async function workflow(body: Record<string, unknown>, tenant = t, as = me) {
  return (await call(list.POST, { as, body: { t: tenant.slug, instructions: "", writes: [], ...body } })).json.id as number;
}
const runsOf = async (id: number) => (await call(runs.GET, { as: me, ctx: ctx(id) })).json.rows as Run[];

type Run = { id: number; status: string; who: string; startedAt: string; finishedAt: string | null; counts: Record<string, number>; report: string };
type Start = { runId: number; workflow: { id: number; name: string }; instructions: string; writes: string[];
  tenant: { slug: string; name: string; domain: string; researchPrompt: string; leadsPerDay: number; templates: { key: string; name: string }[] }; next: string };

beforeAll(async () => {
  me = await fx.user(); t = await fx.tenant(me);
  them = await fx.user(); theirs = await fx.tenant(them);
  await db.update(tenants).set({ settings: { prompt: "Suche Tiefbaufirmen in NRW.", leadsPerDay: 7, cooldownDays: 30 } }).where(eq(tenants.id, t.id));
  await db.insert(templates).values([{ tenantId: t.id, key: "A", name: "Erstkontakt", subject: "Hallo", body: "Text" }, { tenantId: t.id, key: "B", name: "Aus", subject: "x", body: "y", active: false }]);
  c = await mcp((await connectorTokens(me)).access_token);
});
afterAll(async () => { await c?.close(); await fx.cleanup(); });

describe("workflows_list", () => {
  it("listet die Workflows des Mandanten mit erstem Satz der Anweisung", async () => {
    const u = await fx.tenant(me);
    const id = await workflow({ name: "Recherche", instructions: "Finde zehn Firmen. Danach anreichern.", writes: ["leads_add", "report"] }, u);
    const rows = await c.tool<{ id: number; name: string; writes: string[]; active: boolean; summary: string }[]>("workflows_list", { tenant: u.slug });
    expect(rows).toEqual([{ id, name: "Recherche", writes: ["leads_add", "report"], active: true, summary: "Finde zehn Firmen." }]);
    await expect(c.tool("workflows_list", { tenant: theirs.slug })).rejects.toThrow("Mandant nicht gefunden");
  });
});

describe("workflow_start", () => {
  it("per Name: legt Lauf an und liefert Anweisung, Ergebnisse und Mandanten-Kontext", async () => {
    const id = await workflow({ name: "Ausschreibungs-Recherche", instructions: "Suche Ausschreibungen.", writes: ["leads_add"] });
    const s = await c.tool<Start>("workflow_start", { tenant: t.slug, workflow: "ausschreibungs-recherche" });
    expect(s).toMatchObject({ runId: expect.any(Number), workflow: { id, name: "Ausschreibungs-Recherche" }, instructions: "Suche Ausschreibungen.", writes: ["leads_add"],
      tenant: { slug: t.slug, name: t.name, domain: "example.test", researchPrompt: "Suche Tiefbaufirmen in NRW.", leadsPerDay: 7, templates: [{ key: "A", name: "Erstkontakt" }] } });
    expect(s.next).toContain(`run: ${s.runId}`);
    expect(s.next).toContain("run_finish");
    const [r] = await runsOf(id);
    expect(r).toMatchObject({ id: s.runId, status: "läuft", who: me.name, report: "", finishedAt: null, counts: { added: 0, skipped: 0, updated: 0, templates: 0 } });
  });

  it("per id; inaktiv, unbekannt oder fremd → Fehler", async () => {
    const id = await workflow({ name: "Per Id" });
    expect((await c.tool<Start>("workflow_start", { tenant: t.slug, workflow: id })).workflow.id).toBe(id);
    const off = await workflow({ name: "Pausiert", active: false });
    await expect(c.tool("workflow_start", { tenant: t.slug, workflow: off })).rejects.toThrow("inaktiv");
    await expect(c.tool("workflow_start", { tenant: t.slug, workflow: "Gibt es nicht" })).rejects.toThrow("Workflow nicht gefunden");
    const foreign = await workflow({ name: "Fremd" }, theirs as typeof t, them);
    await expect(c.tool("workflow_start", { tenant: t.slug, workflow: foreign })).rejects.toThrow("Workflow nicht gefunden");
    await expect(c.tool("workflow_start", { tenant: theirs.slug, workflow: foreign })).rejects.toThrow("Mandant nicht gefunden");
  });
});

type Added = { added: { id: number; company: string }[]; skipped: { company: string; why: string }[] };
const start = async (body: Record<string, unknown>) => { const id = await workflow(body); return { id, run: (await c.tool<Start>("workflow_start", { tenant: t.slug, workflow: id })).runId }; };

describe("Schreib-Tools mit run", () => {
  it("leads_add zählt neue und übersprungene, Quelle = Workflow-Name", async () => {
    const { id, run } = await start({ name: "Messe-Import", writes: ["leads_add", "leads_update"] });
    const a = await c.tool<Added>("leads_add", { tenant: t.slug, run, rows: [{ company: "Gamma GmbH", email: "g@gamma.de" }, { company: "Delta AG" }] });
    const b = await c.tool<Added>("leads_add", { tenant: t.slug, run, rows: [{ company: "Gamma GmbH", email: "g@gamma.de" }, { company: "Eps KG" }] });
    expect(b.skipped).toHaveLength(1);
    await c.tool("leads_update", { tenant: t.slug, run, updates: [{ id: a.added[0].id, role: "CEO" }, { id: a.added[1].id, city: "Bonn" }, { id: 999999999, city: "X" }] });
    expect((await runsOf(id))[0].counts).toEqual({ added: 3, skipped: 1, updated: 2, templates: 0 });
    const { json } = await call(leadsGet, { as: me, path: `/api/leads?t=${t.slug}` });
    expect(json.rows.find((r: { id: number }) => r.id === a.added[0].id)).toMatchObject({ source: "Messe-Import", role: "CEO" });
  });

  it("nicht erlaubtes Ergebnis → Fehler, nichts geschrieben", async () => {
    const { id, run } = await start({ name: "Nur Bericht", writes: ["report"] });
    await expect(c.tool("leads_add", { tenant: t.slug, run, rows: [{ company: "Zeta GmbH" }] })).rejects.toThrow("Neue Leads");
    const { json } = await call(leadsGet, { as: me, path: `/api/leads?t=${t.slug}` });
    expect(json.rows.some((r: { company: string }) => r.company === "Zeta GmbH")).toBe(false);
    const l = json.rows[0];
    await expect(c.tool("leads_update", { tenant: t.slug, run, updates: [{ id: l.id, note: "geändert" }] })).rejects.toThrow("Leads anreichern");
    expect((await call(leadsGet, { as: me, path: `/api/leads?t=${t.slug}` })).json.rows[0].note).toBe(l.note);
    expect((await runsOf(id))[0].counts).toEqual({ added: 0, skipped: 0, updated: 0, templates: 0 });
  });

  it("Lauf eines anderen Mandanten → nicht gefunden; ohne run ad hoc erlaubt", async () => {
    const { run } = await start({ name: "Woanders", writes: ["leads_add"] });
    const u = await fx.tenant(me);
    await expect(c.tool("leads_add", { tenant: u.slug, run, rows: [{ company: "Eta GmbH" }] })).rejects.toThrow("Lauf nicht gefunden");
    expect((await c.tool<Added>("leads_add", { tenant: u.slug, rows: [{ company: "Eta GmbH" }] })).added).toHaveLength(1);
  });
});

describe("run_finish", () => {
  it("legt Bericht ab, schließt den Lauf; danach keine Schreibzugriffe mehr", async () => {
    const { id, run } = await start({ name: "Mit Bericht", writes: ["leads_add", "report"] });
    await c.tool("leads_add", { tenant: t.slug, run, rows: [{ company: "Theta GmbH" }] });
    const r = await c.tool<{ status: string; counts: Record<string, number> }>("run_finish", { run, report: "## Ergebnis\n- 1 Firma" });
    expect(r).toMatchObject({ status: "fertig", counts: { added: 1 } });
    expect((await runsOf(id))[0]).toMatchObject({ status: "fertig", report: "## Ergebnis\n- 1 Firma", finishedAt: expect.any(String) });
    await expect(c.tool("leads_add", { tenant: t.slug, run, rows: [{ company: "Iota GmbH" }] })).rejects.toThrow("Lauf ist fertig");
    await expect(c.tool("run_finish", { run, report: "nochmal" })).rejects.toThrow("Lauf ist fertig");
  });

  it("Bericht ohne Erlaubnis abgelehnt, ohne Bericht abschließbar; abgebrochen möglich", async () => {
    const { id, run } = await start({ name: "Ohne Bericht", writes: [] });
    await expect(c.tool("run_finish", { run, report: "Text" })).rejects.toThrow("keinen Bericht");
    await c.tool("run_finish", { run, status: "abgebrochen" });
    expect((await runsOf(id))[0]).toMatchObject({ status: "abgebrochen", report: "" });
  });

  it("nur eigene Läufe", async () => {
    const { run } = await start({ name: "Meins", writes: ["report"] });
    const other = await mcp((await connectorTokens(them)).access_token);
    await expect(other.tool("run_finish", { run, report: "x" })).rejects.toThrow("Lauf nicht gefunden");
    await other.close();
  });
});

describe("Läufe ohne Abschluss", () => {
  it("nach 24 h als abgebrochen angezeigt und nicht mehr beschreibbar", async () => {
    const { id, run } = await start({ name: "Vergessen", writes: ["leads_add"] });
    await db.update(workflowRuns).set({ startedAt: new Date(Date.now() - 25 * 3600e3) }).where(eq(workflowRuns.id, run));
    expect((await runsOf(id))[0].status).toBe("abgebrochen");
    expect((await call(list.GET, { as: me, path: `/api/workflows?t=${t.slug}` })).json.rows.find((w: { id: number }) => w.id === id).lastRun.status).toBe("abgebrochen");
    await expect(c.tool("leads_add", { tenant: t.slug, run, rows: [{ company: "Kappa GmbH" }] })).rejects.toThrow("Lauf ist abgebrochen");
  });
});
