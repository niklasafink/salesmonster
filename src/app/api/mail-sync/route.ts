import { HttpError, qp, route, tenantBySlug } from "@/lib/api";
import { getInteg } from "@/lib/integrations";
import { resetSync, startSync, stepSync, syncState } from "@/lib/mail-sync";

export const maxDuration = 60;

export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  return syncState(t.id, me.id);
});

/* start: begin or pick up new mail; step: one slice of the run (the page calls it until it is done) */
export const POST = route(async (req, _c, me) => {
  const { t: slug, action } = await req.json() as { t: string; action?: "start" | "step" };
  const t = await tenantBySlug(slug, me);
  if (action === "start") {
    const src = await getInteg(t.id, "outlook", me.id) ? "outlook" : await getInteg(t.id, "imap", me.id) ? "imap" : null;
    if (!src) throw new HttpError(400, "Kein Postfach verbunden");
    await startSync(t.id, me.id, src);
  }
  return stepSync(t.id, me.id, 45_000);
});

export const DELETE = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  await resetSync(t.id, me.id);
});
