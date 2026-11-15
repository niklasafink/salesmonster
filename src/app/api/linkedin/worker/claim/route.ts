import { eq } from "drizzle-orm";
import { db, liSenders } from "@/db";
import { publicError } from "@/lib/api";
import { claim, LOGIN_PAUSE, senderByToken } from "@/lib/linkedin";

/* The local worker (bridge/linkedin.mjs) asks for its next action; answers { action } or { wait, reason } */
export async function POST(req: Request) {
  let sender = await senderByToken(req.headers.get("authorization"));
  if (!sender) return Response.json({ error: "Nicht berechtigt" }, { status: 401 });
  try {
    const body = (await req.json().catch(() => ({}))) as { info?: unknown; loggedIn?: unknown };
    const info = String(body.info || "").slice(0, 200);
    if (info && info !== sender.workerInfo) await db.update(liSenders).set({ workerInfo: info }).where(eq(liSenders.id, sender.id));
    /* the worker is logged in to LinkedIn again: lift the pause that an expired login caused (a pause set by hand stays) */
    if (body.loggedIn === true && sender.paused && sender.pauseReason?.startsWith(LOGIN_PAUSE)) {
      await db.update(liSenders).set({ paused: false, pauseReason: "" }).where(eq(liSenders.id, sender.id));
      sender = { ...sender, paused: false, pauseReason: "" };
    }
    return Response.json(await claim(sender));
  } catch (e) {
    const { status, message } = publicError(e);
    return Response.json({ error: message }, { status });
  }
}
