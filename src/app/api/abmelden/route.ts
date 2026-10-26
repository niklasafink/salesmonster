import { and, eq, inArray } from "drizzle-orm";
import { db, enrollments, sequences } from "@/db";
import { suppressEmail } from "@/lib/suppress";
import { OPEN, unsubId } from "@/lib/sequences";

const page = (text: string, status = 200) => new Response(
  `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Abmeldung</title>
<body style="font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#fafafa;color:#111"><p style="padding:0 16px">${text}</p></body></html>`,
  { status, headers: { "content-type": "text/html; charset=utf-8" } });

/* Link at the end of every sequence mail; GET confirms, the form POSTs, so link scanners do not unsubscribe anyone */
export async function GET(req: Request) {
  const e = new URL(req.url).searchParams.get("e") || "";
  if (!unsubId(e)) return page("Dieser Link ist ungültig.", 400);
  return page(`<form method="post"><input type="hidden" name="e" value="${e.replace(/[^\w.-]/g, "")}">Keine weiteren Mails von uns erhalten?<br><br><button style="font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #ccc;background:#fff;cursor:pointer">Abmelden</button></form>`);
}

export async function POST(req: Request) {
  const id = unsubId(String((await req.formData()).get("e") || ""));
  if (!id) return page("Dieser Link ist ungültig.", 400);
  await db.update(enrollments).set({ status: "abgemeldet" }).where(and(eq(enrollments.id, id), inArray(enrollments.status, OPEN)));
  /* an unsubscribe holds for every mail from this tenant: it goes on the block list */
  const [e] = await db.select({ email: enrollments.email, tenantId: sequences.tenantId, name: sequences.name }).from(enrollments).innerJoin(sequences, eq(sequences.id, enrollments.sequenceId)).where(eq(enrollments.id, id));
  if (e) await suppressEmail(e.tenantId, e.email, "abgemeldet", e.name);
  return page("Sie sind abgemeldet und erhalten keine weiteren Mails von uns.");
}
