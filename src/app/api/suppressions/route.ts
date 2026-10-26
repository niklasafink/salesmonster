import { and, eq } from "drizzle-orm";
import { db, suppressions } from "@/db";
import { HttpError, body, qp, route, tenantBySlug } from "@/lib/api";
import { listSuppressions, parseEntry, suppress } from "@/lib/suppress";

export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  return listSuppressions(t.id, (qp(req, "q") || "").trim().toLowerCase(), 200, Math.max(0, Number(qp(req, "offset")) || 0));
});

/* lines of addresses, domains or LinkedIn links; what is no entry is reported back */
export const POST = route(async (req, _c, me) => {
  const b = await body(req), t = await tenantBySlug(String(b.t || ""), me);
  if (typeof b.entries !== "string") throw new HttpError(400, "Ungültige Eingabe");
  const lines = b.entries.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean).slice(0, 5000);
  const parsed = lines.map(l => [l, parseEntry(l)] as const);
  const added = await suppress(t.id, parsed.flatMap(([, e]) => e ? [e] : []), "manuell", { note: typeof b.note === "string" ? b.note.slice(0, 200) : "", userId: me.id });
  return { added, invalid: parsed.filter(([, e]) => !e).map(([l]) => l).slice(0, 50) };
});

export const DELETE = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me), id = Number(qp(req, "id"));
  if (!Number.isInteger(id)) throw new HttpError(400, "id fehlt");
  await db.delete(suppressions).where(and(eq(suppressions.id, id), eq(suppressions.tenantId, t.id)));
});
