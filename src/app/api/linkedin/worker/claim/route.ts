import { eq } from "drizzle-orm";
import { db, liSenders } from "@/db";
import { publicError } from "@/lib/api";
import { claim, senderByToken } from "@/lib/linkedin";

/* The local worker (bridge/linkedin.mjs) asks for its next action; answers { action } or { wait, reason } */
export async function POST(req: Request) {
  const sender = await senderByToken(req.headers.get("authorization"));
  if (!sender) return Response.json({ error: "Nicht berechtigt" }, { status: 401 });
  try {
    const info = String(((await req.json().catch(() => ({}))) as { info?: unknown }).info || "").slice(0, 200);
    if (info && info !== sender.workerInfo) await db.update(liSenders).set({ workerInfo: info }).where(eq(liSenders.id, sender.id));
    return Response.json(await claim(sender));
  } catch (e) {
    const { status, message } = publicError(e);
    return Response.json({ error: message }, { status });
  }
}
