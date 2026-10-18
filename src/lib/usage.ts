import { AsyncLocalStorage } from "node:async_hooks";
import { db, aiUsage } from "@/db";

/* What one action costs. track() opens the action, every AI call inside reports its cost with spend(), and the action writes one row when it ends.
   An action inside another one counts for the outer one, so the evening run is one entry with its research and ratings;
   an inner action of the same kind adds its items to the outer one (each lead of an enrich job).
   A call that reports after its action has ended (work handed to after()) writes its own row under the same kind and ref. */
export type UsageKind = "recherche" | "runde" | "anreicherung" | "bewertung" | "import" | "impressum" | "signaturen" | "einrichtung" | "texte" | "strecke" | "chat";

type Ctx = { tenantId: number; userId?: number; kind: UsageKind; ref?: string; items: number; calls: number; unpriced: number; cost: number; started: Date; closed: boolean };
export type Meter = { count: (n: number) => void };

const als = new AsyncLocalStorage<Ctx>();
const NOOP: Meter = { count: () => {} };
const meter = (c: Ctx): Meter => ({ count: n => { c.items += n; } });

const write = (c: Ctx) => db.insert(aiUsage).values({ tenantId: c.tenantId, userId: c.userId, kind: c.kind, ref: c.ref, items: c.items, calls: c.calls, unpriced: c.unpriced, cost: Math.round(c.cost), startedAt: c.started })
  .catch(e => console.error("usage", (e as Error).message));

export async function track<T>(a: { tenantId: number; userId?: number; kind: UsageKind; ref?: string }, fn: (m: Meter) => Promise<T>): Promise<T> {
  const outer = als.getStore();
  if (outer && !outer.closed) return fn(outer.kind === a.kind ? meter(outer) : NOOP);
  const c: Ctx = { ...a, items: 0, calls: 0, unpriced: 0, cost: 0, started: new Date(), closed: false };
  try { return await als.run(c, () => fn(meter(c))); }
  finally {
    c.closed = true;
    if (c.calls) await write(c);
  }
}

/* One AI call; cost in dollars as the provider reported it, null when it reports none */
export function spend(dollars: number | null | undefined) {
  const c = als.getStore();
  if (!c) { console.warn("usage: AI call outside an action"); return; }
  const micro = typeof dollars === "number" && isFinite(dollars) ? dollars * 1e6 : null;
  if (c.closed) { void write({ ...c, items: 0, calls: 1, unpriced: micro === null ? 1 : 0, cost: micro ?? 0, started: new Date() }); return; }
  c.calls++;
  if (micro === null) c.unpriced++; else c.cost += micro;
}
