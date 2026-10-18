import { eq } from "drizzle-orm";
import { Webhook } from "svix";
import { db, tenants } from "@/db";
import { getInteg } from "@/lib/integrations";
import { sendpilotEvent, type SendPilotConfig, type SendPilotEvent } from "@/lib/sendpilot";

/* SendPilot → portal, one URL per tenant. Signed through Svix with the secret stored in the tenant's SendPilot connection. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, (await params).slug));
  const c = t && await getInteg<SendPilotConfig>(t.id, "sendpilot");
  if (!c?.secret) return new Response("Not found", { status: 404 });
  const raw = await req.text();
  let ev: SendPilotEvent;
  try { ev = new Webhook(c.secret).verify(raw, Object.fromEntries(req.headers)) as SendPilotEvent; }
  catch { return new Response("Invalid signature", { status: 400 }); }
  if (c.workspace && ev.workspaceId && ev.workspaceId !== c.workspace) return new Response("Wrong workspace", { status: 400 });
  const updated = await sendpilotEvent(t.id, ev);
  return Response.json({ updated });
}
