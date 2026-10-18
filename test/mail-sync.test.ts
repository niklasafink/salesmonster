import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, leads } from "@/db";
import type { Head, Source } from "@/lib/mail-source";
import { fixtures } from "./helpers";

/* A fake mailbox per tenant: what the sync sees instead of Microsoft 365 or IMAP */
const boxes = new Map<number, { me: string; heads: Head[]; bodies: Record<string, string[]> }>();
vi.mock("@/lib/mail-source", () => ({
  openSource: async (tenantId: number): Promise<Source | null> => {
    const b = boxes.get(tenantId);
    if (!b) return null;
    return { kind: "imap", me: b.me, close: async () => {},
      page: async c => { const i = Number(c.next || 0); return { heads: b.heads.slice(i, i + 2), cursor: { next: i + 2 < b.heads.length ? String(i + 2) : undefined }, done: i + 2 >= b.heads.length }; },
      bodies: async from => b.bodies[from] || [] };
  },
}));
const { startSync, stepSync } = await import("@/lib/mail-sync");

const fx = fixtures();
let me: { id: number }, a: { id: number; slug: string }, b: { id: number; slug: string };
const d = (s: string) => new Date(s);
const out = (to: string, name = "", date = "2026-10-01") => ({ from: { email: "niklas@vh.test", name: "Niklas" }, to: [{ email: to, name }], outgoing: true, bulk: false, date: d(date) });
const inn = (from: string, name: string, bulk = false, date = "2026-10-02") => ({ from: { email: from, name }, to: [{ email: "niklas@vh.test", name: "" }], outgoing: false, bulk, date: d(date) });

beforeAll(async () => {
  me = await fx.user();
  a = await fx.tenant(me); b = await fx.tenant(me);
  boxes.set(a.id, { me: "niklas@vh.test", bodies: {
    "anna@mueller-bau.de": ["Passt.\n\nViele Grüße\nAnna Müller\nLeiterin Einkauf\nMüller Bau GmbH\nTel. +49 89 1234567\nwww.mueller-bau.de"] },
    heads: [out("anna@mueller-bau.de", "Müller, Anna"), inn("anna@mueller-bau.de", "Anna Müller"), out("tom@mueller-bau.de", "Tom Weber"),
      inn("newsletter@shop.de", "Shop", true), inn("noreply@github.com", "GitHub"), out("kollege@vh.test", "Kollege"), inn("max@cold.de", "Max Kalt"),
      out("privat@gmail.com", "Privat")] });
  boxes.set(b.id, { me: "niklas@chetti.test", bodies: {}, heads: [out("eva@kunde-b.de", "Eva Berg")] });
});
afterAll(() => fx.cleanup());

async function run(tid: number) {
  await startSync(tid, me.id, "imap");
  let s = null;
  for (let i = 0; i < 20; i++) { s = await stepSync(tid, me.id, 20_000); if (s?.status !== "läuft") break; }
  return s;
}

describe("Kontakte aus dem Postfach", () => {
  it("übernimmt Personen mit echtem Austausch, mit Signatur, als Status kontakt", async () => {
    const s = await run(a.id);
    expect(s).toMatchObject({ status: "fertig", scanned: 8 });
    const rows = await db.select().from(leads).where(eq(leads.tenantId, a.id));
    expect(rows.map(r => r.email).sort()).toEqual(["anna@mueller-bau.de", "tom@mueller-bau.de"]);
    const anna = rows.find(r => r.email === "anna@mueller-bau.de")!;
    expect(anna).toMatchObject({ status: "kontakt", source: "Postfach", first: "Anna", last: "Müller", role: "Leiterin Einkauf", company: "Müller Bau GmbH", phone: "+49 89 1234567" });
    expect(anna.research).toMatch(/^Signatur:/);
    /* the colleague at the same domain gets the company from the signature */
    expect(rows.find(r => r.email === "tom@mueller-bau.de")!.companyId).toBe(anna.companyId);
  });

  it("ein zweiter Lauf legt nichts doppelt an und macht einen geplanten Lead zum Kontakt", async () => {
    await db.insert(leads).values({ tenantId: a.id, company: "Neu GmbH", email: "neu@neu-gmbh.de", status: "neu" });
    boxes.get(a.id)!.heads.push(out("neu@neu-gmbh.de", "Nina Neu", "2026-10-05"), inn("anna@mueller-bau.de", "Anna Müller", false, "2026-10-06"));
    await run(a.id);
    const rows = await db.select().from(leads).where(eq(leads.tenantId, a.id));
    expect(rows.filter(r => r.email === "anna@mueller-bau.de")).toHaveLength(1);
    expect(rows.find(r => r.email === "neu@neu-gmbh.de")!.status).toBe("kontakt");
  });

  it("jeder Mandant liest nur sein eigenes Postfach", async () => {
    await run(b.id);
    const inB = await db.select({ email: leads.email }).from(leads).where(eq(leads.tenantId, b.id));
    expect(inB.map(r => r.email)).toEqual(["eva@kunde-b.de"]);
    const leak = await db.select().from(leads).where(and(eq(leads.tenantId, a.id), eq(leads.email, "eva@kunde-b.de")));
    expect(leak).toHaveLength(0);
  });
});
