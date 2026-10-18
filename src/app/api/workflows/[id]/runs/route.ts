import { assertMember, idOf, route } from "@/lib/api";
import { runsOf, workflowOf } from "@/lib/workflows";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }, me) => {
  const w = await workflowOf(await idOf(params, "Workflow"));
  await assertMember(me, w.tenantId, "Workflow");
  return { rows: await runsOf(w.id) };
});
