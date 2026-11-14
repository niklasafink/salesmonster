import { z } from "zod";
import { publicError } from "@/lib/api";
import { report, senderByToken } from "@/lib/linkedin";

const Body = z.object({
  id: z.number().int(),
  outcome: z.string().min(1).max(40),
  detail: z.string().max(2000).optional(),
  connected: z.boolean().optional(), pending: z.boolean().optional(), replied: z.boolean().optional(), found: z.boolean().optional(),
  reply: z.string().max(5000).optional(),
});

/* The worker says what happened with an action it was handed */
export async function POST(req: Request) {
  const sender = await senderByToken(req.headers.get("authorization"));
  if (!sender) return Response.json({ error: "Nicht berechtigt" }, { status: 401 });
  const b = Body.safeParse(await req.json().catch(() => null));
  if (!b.success) return Response.json({ error: "Ungültige Rückmeldung" }, { status: 400 });
  try {
    const { id, ...r } = b.data;
    return Response.json(await report(sender, id, r));
  } catch (e) {
    const { status, message } = publicError(e);
    return Response.json({ error: message }, { status });
  }
}
