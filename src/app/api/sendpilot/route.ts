import { body, HttpError, qp, route, tenantBySlug } from "@/lib/api";
import { sendpilotCampaigns, sendpilotConfig, sendpilotPush } from "@/lib/sendpilot";

export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  return { campaigns: await sendpilotCampaigns((await sendpilotConfig(t.id)).key) };
});

/* { t, campaignId, leadIds } → leads into the campaign */
export const POST = route(async (req, _c, me) => {
  const b = await body(req);
  const t = await tenantBySlug(String(b.t ?? ""), me);
  if (typeof b.campaignId !== "string" || !b.campaignId) throw new HttpError(400, "Kampagne fehlt");
  const ids = Array.isArray(b.leadIds) ? b.leadIds.filter((x): x is number => Number.isSafeInteger(x)) : [];
  return sendpilotPush(t.id, b.campaignId, ids);
});
