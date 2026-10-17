import { HttpError, qp, route, tenantBySlug } from "@/lib/api";
import { impressum } from "@/lib/claude";
import { aiFor } from "@/lib/ai";

export const maxDuration = 120;

export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  const domain = (qp(req, "domain") || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[\w.-]+\.[a-z]{2,}$/i.test(domain)) throw new HttpError(400, "Domain fehlt");
  const key = await aiFor(t.id);
  if (!key) throw new HttpError(400, "Keine KI verbunden");
  return impressum(key, domain);
});
