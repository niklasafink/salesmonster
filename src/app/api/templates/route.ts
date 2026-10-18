import { eq } from "drizzle-orm";
import { db, templates } from "@/db";
import { body, route, tenantBySlug } from "@/lib/api";
import { nextKey } from "@/lib/playbook";

/* A new template starts paused and empty; it is sent only once someone fills and activates it */
export const POST = route(async (req, _c, me) => {
  const b = await body(req);
  const t = await tenantBySlug(typeof b.t === "string" ? b.t : null, me);
  const rows = await db.select({ key: templates.key, tone: templates.tone }).from(templates).where(eq(templates.tenantId, t.id));
  const key = nextKey(new Set(rows.map(x => x.key)));
  await db.insert(templates).values({ tenantId: t.id, key, name: `Vorlage ${key}`, tone: rows[0]?.tone || "sie", subject: "",
    body: `{{anrede}}\n\n\n\nViele Grüße\n{{absender}}`, active: false, origin: "Nutzer" });
  return { key };
});
