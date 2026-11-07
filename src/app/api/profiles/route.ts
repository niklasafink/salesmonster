import { body, qp, route, tenantBySlug } from "@/lib/api";
import { createProfile, listProfiles } from "@/lib/profiles";

/* The tenant's lead profiles, default first */
export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  return { profiles: await listProfiles(t.id) };
});

/* A new profile with its target group; templates and leads are assigned to it afterwards */
export const POST = route(async (req, _c, me) => {
  const b = await body(req);
  const t = await tenantBySlug(typeof b.t === "string" ? b.t : null, me);
  return { profile: await createProfile(t.id, String(b.name ?? ""), typeof b.audience === "string" ? b.audience : "") };
});
