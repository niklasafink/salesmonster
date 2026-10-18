import { HttpError, route, tenantBySlug } from "@/lib/api";
import { runResearch, sendApproved } from "@/lib/outreach";
import { optimizeTemplates } from "@/lib/optimize";

export const maxDuration = 300;

export const POST = route(async (req, _c, me) => {
  const { t: slug, job } = await req.json();
  const t = await tenantBySlug(slug, me);
  if (job === "research") return runResearch(t, { force: true });
  if (job === "send") return sendApproved(t, { now: true });
  if (job === "optimize") return optimizeTemplates(t);
  throw new HttpError(400, "Unbekannter Auftrag");
});
