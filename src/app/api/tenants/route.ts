import { HttpError, route } from "@/lib/api";
import { createTenant } from "@/lib/tenants";

export const POST = route(async (req, _c, me) => {
  const { name, domain } = await req.json();
  if (!String(name || "").trim() || !String(domain || "").trim()) throw new HttpError(400, "Name und Domain angeben");
  return { slug: await createTenant(String(name), String(domain), me.id) };
});
