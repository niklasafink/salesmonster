import { HttpError, qp, route, tenantBySlug } from "@/lib/api";
import { impressum } from "@/lib/claude";
import { aiFor } from "@/lib/ai";
import { track } from "@/lib/usage";

export const maxDuration = 120;

export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  const domain = (qp(req, "domain") || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[\w.-]+\.[a-z]{2,}$/i.test(domain)) throw new HttpError(400, "Domain fehlt");
  const key = await aiFor(t.id, me.id);
  if (!key) throw new HttpError(400, "Keine KI verbunden");
  return track({ tenantId: t.id, userId: me.id, kind: "impressum" }, m => { m.count(1); return impressum(key, domain); });
});
