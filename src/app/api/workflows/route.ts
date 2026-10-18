import { desc, eq, isNotNull, and } from "drizzle-orm";
import { db, workflowRuns, workflows } from "@/db";
import { HttpError, qp, route, tenantBySlug } from "@/lib/api";
import { cleanWorkflow, runStatus } from "@/lib/workflows";

export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  const rows = await db.select().from(workflows).where(eq(workflows.tenantId, t.id)).orderBy(desc(workflows.createdAt), desc(workflows.id));
  const last = await db.selectDistinctOn([workflowRuns.workflowId], { wf: workflowRuns.workflowId, status: workflowRuns.status, startedAt: workflowRuns.startedAt }).from(workflowRuns)
    .where(and(eq(workflowRuns.tenantId, t.id), isNotNull(workflowRuns.workflowId))).orderBy(workflowRuns.workflowId, desc(workflowRuns.startedAt));
  const byWf = new Map(last.map(r => [r.wf, { status: runStatus(r), startedAt: r.startedAt }]));
  return { rows: rows.map(w => ({ id: w.id, name: w.name, instructions: w.instructions, writes: w.writes, active: w.active, lastRun: byWf.get(w.id) ?? null })) };
});

export const POST = route(async (req, _c, me) => {
  const b = await req.json();
  const t = await tenantBySlug(b.t, me);
  const v = cleanWorkflow({ name: b.name ?? "", instructions: b.instructions ?? "", writes: b.writes ?? [], active: b.active ?? true });
  if (!v.name) throw new HttpError(400, "Name fehlt");
  const [w] = await db.insert(workflows).values({ ...v, name: v.name, tenantId: t.id }).returning({ id: workflows.id });
  return { id: w.id };
});
