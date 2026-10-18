import { and, desc, eq, sql } from "drizzle-orm";
import { db, users, workflowRuns, workflows, WRITES, type RunCounts, type Write } from "@/db";
import { HttpError } from "@/lib/api";

const DAY = 24 * 3600e3;

/* A run nobody finished within a day counts as aborted; nothing rewrites it, it just reads that way */
export const runStatus = (r: { status: string; startedAt: Date }) => r.status === "läuft" && Date.now() - r.startedAt.getTime() > DAY ? "abgebrochen" : r.status;

export const WRITE_LABEL: Record<Write, string> = { leads_add: "Neue Leads", leads_update: "Leads anreichern", templates: "Mail-Vorlagen", report: "Bericht" };

/* Fields of a workflow from a request body; unknown writes are dropped */
export function cleanWorkflow(b: { name?: unknown; instructions?: unknown; writes?: unknown; active?: unknown }) {
  const set: Partial<typeof workflows.$inferInsert> = {};
  if (b.name !== undefined) { set.name = String(b.name).trim(); if (!set.name) throw new HttpError(400, "Name fehlt"); }
  if (b.instructions !== undefined) set.instructions = String(b.instructions);
  if (b.writes !== undefined) set.writes = WRITES.filter(w => Array.isArray(b.writes) && b.writes.includes(w));
  if (b.active !== undefined) set.active = !!b.active;
  return set;
}

export async function workflowOf(id: number) {
  const [w] = await db.select().from(workflows).where(eq(workflows.id, id));
  if (!w) throw new HttpError(404, "Workflow nicht gefunden");
  return w;
}

export async function runsOf(workflowId: number) {
  const rows = await db.select({ r: workflowRuns, who: users.name }).from(workflowRuns).leftJoin(users, eq(users.id, workflowRuns.userId))
    .where(eq(workflowRuns.workflowId, workflowId)).orderBy(desc(workflowRuns.startedAt), desc(workflowRuns.id)).limit(50);
  return rows.map(({ r, who }) => ({ id: r.id, status: runStatus(r), who: who || "", startedAt: r.startedAt, finishedAt: r.finishedAt, counts: r.counts, report: r.report }));
}

export type RunHandle = { id: number; workflow: string; count: (d: Partial<RunCounts>) => Promise<void> };

/* For write tools called with `run`: the run must belong to the tenant, still be running, and its workflow must allow `write`.
   Without a run (ad-hoc use) it returns null and nothing is counted. */
export async function checkRun(run: number | undefined, tenantId: number, write: Write): Promise<RunHandle | null> {
  if (run === undefined) return null;
  const [row] = await db.select({ r: workflowRuns, w: workflows }).from(workflowRuns).leftJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
    .where(and(eq(workflowRuns.id, run), eq(workflowRuns.tenantId, tenantId)));
  if (!row) throw new HttpError(404, "Lauf nicht gefunden");
  if (runStatus(row.r) !== "läuft") throw new HttpError(409, `Lauf ist ${runStatus(row.r)}`);
  if (!row.w) throw new HttpError(409, "Workflow des Laufs gelöscht");
  if (!row.w.writes.includes(write)) throw new HttpError(403, `Der Workflow „${row.w.name}“ darf nicht: ${WRITE_LABEL[write]}`);
  return { id: run, workflow: row.w.name, count: d => countRun(run, d) };
}

/* Adds to the run's counters in one statement, so parallel tool calls don't lose increments */
async function countRun(id: number, d: Partial<RunCounts>) {
  const parts = Object.entries(d).filter(([, n]) => n).map(([k, n]) => sql`${k}::text, coalesce((${workflowRuns.counts}->>${k}::text)::int, 0) + ${n}::int`);
  if (!parts.length) return;
  await db.update(workflowRuns).set({ counts: sql`${workflowRuns.counts} || jsonb_build_object(${sql.join(parts, sql`, `)})` }).where(eq(workflowRuns.id, id));
}
