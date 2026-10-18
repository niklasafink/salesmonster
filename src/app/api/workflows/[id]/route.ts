import { eq } from "drizzle-orm";
import { db, workflows } from "@/db";
import { assertMember, idOf, route } from "@/lib/api";
import { cleanWorkflow, workflowOf } from "@/lib/workflows";

type Ctx = { params: Promise<{ id: string }> };

export const PUT = route<Ctx>(async (req, { params }, me) => {
  const w = await workflowOf(await idOf(params, "Workflow"));
  await assertMember(me, w.tenantId, "Workflow");
  await db.update(workflows).set({ ...cleanWorkflow(await req.json()), updatedAt: new Date() }).where(eq(workflows.id, w.id));
});

export const DELETE = route<Ctx>(async (_req, { params }, me) => {
  const w = await workflowOf(await idOf(params, "Workflow"));
  await assertMember(me, w.tenantId, "Workflow");
  await db.delete(workflows).where(eq(workflows.id, w.id));
});
