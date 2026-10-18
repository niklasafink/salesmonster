import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, templates } from "@/db";
import * as wf from "@/app/api/workflows/route";
import * as runsRoute from "@/app/api/workflows/[id]/runs/route";
import { call, connectorTokens, fixtures, mcp } from "./helpers";

const fx = fixtures();
let me: { id: number }, t: { id: number; slug: string }, theirs: { slug: string }, c: Awaited<ReturnType<typeof mcp>>;

type Tpl = { key: string; name: string; tone: string; subject: string; body: string; active: boolean; origin: string; score: { reply: number; weakness: string } | null };

beforeAll(async () => {
  me = await fx.user(); t = await fx.tenant(me);
  theirs = await fx.tenant(await fx.user());
  await db.insert(templates).values([
    { tenantId: t.id, key: "B", name: "Frage zuerst", tone: "du", subject: "Kurze Frage", body: "{{anrede}}\nText B", active: false },
    { tenantId: t.id, key: "A", name: "Anlass zuerst", subject: "Ihre Ausschreibung", body: "{{anrede}}\nText A", origin: "Einrichtung",
      score: { reply: 2.5, specific: 3, easyAsk: 3, weakness: "zu lang", words: 80, subjectLen: 18, hash: "x", n: 3, weaknesses: { "zu lang": 3 } } },
  ]);
  c = await mcp((await connectorTokens(me)).access_token);
});
afterAll(async () => { await c?.close(); await fx.cleanup(); });

describe("templates_list", () => {
  it("liefert alle Vorlagen des Mandanten nach key, mit Jev-Kurzwertung; fremder Mandant → Fehler", async () => {
    expect(await c.tool<Tpl[]>("templates_list", { tenant: t.slug })).toEqual([
      { key: "A", name: "Anlass zuerst", tone: "sie", subject: "Ihre Ausschreibung", body: "{{anrede}}\nText A", active: true, origin: "Einrichtung", score: { reply: 2.5, weakness: "zu lang" } },
      { key: "B", name: "Frage zuerst", tone: "du", subject: "Kurze Frage", body: "{{anrede}}\nText B", active: false, origin: "", score: null },
    ]);
    await expect(c.tool("templates_list", { tenant: theirs.slug })).rejects.toThrow("Mandant nicht gefunden");
  });
});

type Saved = { key: string; created: boolean; active: boolean; hints: string[] };
const listed = async (key: string, slug = t.slug) => (await c.tool<Tpl[]>("templates_list", { tenant: slug })).find(x => x.key === key);

describe("templates_save", () => {
  it("neuer key → inaktiv, Herkunft Claude", async () => {
    const u = await fx.tenant(me);
    const s = await c.tool<Saved>("templates_save", { tenant: u.slug, key: "C", name: "Kurz", tone: "sie", subject: "Frage zu {{firma}}", body: "{{anrede}}\n{{aufhaenger}}\nPasst das?\n{{absender}}" });
    expect(s).toEqual({ key: "C", created: true, active: false, hints: [] });
    expect(await listed("C", u.slug)).toEqual({ key: "C", name: "Kurz", tone: "sie", subject: "Frage zu {{firma}}", body: "{{anrede}}\n{{aufhaenger}}\nPasst das?\n{{absender}}",
      active: false, origin: "Claude", score: null });
  });

  it("bestehender key → überschrieben, Aktiv-Status und Herkunft bleiben, Jev-Wertung zurückgesetzt", async () => {
    const s = await c.tool<Saved>("templates_save", { tenant: t.slug, key: "A", name: "Anlass neu", tone: "du", subject: "Neu", body: "{{anrede}}\nNeu A\n{{absender}}" });
    expect(s).toMatchObject({ key: "A", created: false, active: true });
    expect(await listed("A")).toEqual({ key: "A", name: "Anlass neu", tone: "du", subject: "Neu", body: "{{anrede}}\nNeu A\n{{absender}}", active: true, origin: "Einrichtung", score: null });
    await c.tool("templates_save", { tenant: t.slug, key: "B", name: "Frage zuerst", tone: "du", subject: "Kurze Frage", body: "{{anrede}}\nText B neu" });
    expect(await listed("B")).toMatchObject({ active: false, origin: "" });
    await expect(c.tool("templates_save", { tenant: theirs.slug, key: "A", name: "x", tone: "sie", subject: "x", body: "{{anrede}}" })).rejects.toThrow("Mandant nicht gefunden");
  });

  it("unbekannte oder unpassende Platzhalter → abgelehnt, nichts gespeichert; Prüfhinweise wie im Portal", async () => {
    const u = await fx.tenant(me);
    await expect(c.tool("templates_save", { tenant: u.slug, key: "X", name: "x", tone: "sie", subject: "x", body: "{{anrede}} {{name}}" })).rejects.toThrow("{{name}}");
    await expect(c.tool("templates_save", { tenant: u.slug, key: "X", name: "x", tone: "sie", subject: "x", body: "{{anrede}} {{ausschreibungen}}" })).rejects.toThrow("{{ausschreibungen}}");
    await expect(c.tool("templates_save", { tenant: u.slug, key: "X", name: "x", tone: "Sie", subject: "x", body: "{{anrede}}" })).rejects.toThrow();
    expect(await listed("X", u.slug)).toBeUndefined();
    const s = await c.tool<Saved>("templates_save", { tenant: u.slug, key: "X", name: "x", tone: "sie", subject: "x", body: "{{anrede}} Mehr unter https://x.de" });
    expect(s.hints).toEqual(["{{absender}} fehlt", "{{aufhaenger}} fehlt", "Link im Erstkontakt"]);
  });

  it("mit run: nur wenn der Workflow Vorlagen schreiben darf, zählt je gespeicherter Vorlage", async () => {
    const u = await fx.tenant(me);
    const body = { tenant: u.slug, name: "x", tone: "sie", subject: "x", body: "{{anrede}}" };
    const run = async (writes: string[]) => {
      const { json } = await call(wf.POST, { as: me, body: { t: u.slug, name: `W ${writes.join()}`, instructions: "", writes } });
      return { id: json.id as number, run: (await c.tool<{ runId: number }>("workflow_start", { tenant: u.slug, workflow: json.id })).runId };
    };
    const no = await run(["report"]);
    await expect(c.tool("templates_save", { ...body, key: "N", run: no.run })).rejects.toThrow("Mail-Vorlagen");
    expect(await listed("N", u.slug)).toBeUndefined();
    const yes = await run(["templates"]);
    await c.tool("templates_save", { ...body, key: "Y", run: yes.run });
    await c.tool("templates_save", { ...body, key: "Y", subject: "y", run: yes.run });
    await c.tool("templates_save", { ...body, key: "Z", run: yes.run });
    const runs = (await call(runsRoute.GET, { as: me, ctx: { params: Promise.resolve({ id: String(yes.id) }) } })).json.rows;
    expect(runs[0].counts.templates).toBe(3);
  });
});
