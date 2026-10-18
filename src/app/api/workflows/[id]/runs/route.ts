import { assertMember, route } from "@/lib/api";
import { runsOf, workflowOf } from "@/lib/workflows";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }, me) => {
  const w = await workflowOf(Number((await params).id));
  await assertMember(me, w.tenantId, "Workflow");
  return { rows: await runsOf(w.id) };
});
