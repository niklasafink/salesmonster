import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db, leads, messages } from "@/db";
import { HttpError } from "./api";
import { getInteg } from "./integrations";
import { blockedOf, blockedWhy, linkedinKey } from "./suppress";

/* SendPilot runs the LinkedIn outreach: leads with a profile URL go into one of its campaigns, its webhooks report back */
export type SendPilotConfig = { key: string; secret: string; workspace: string };
export type Campaign = { id: string; name: string; status: string; totalLeads: number };

async function sp(key: string, path: string, init?: RequestInit) {
  const r = await fetch(`https://api.sendpilot.ai${path}`, { ...init, headers: { "x-api-key": key, "content-type": "application/json", ...(init?.headers || {}) } });
  if (r.status === 401) throw new HttpError(400, "SendPilot: API-Schlüssel ungültig");
  if (r.status === 402) throw new HttpError(400, "SendPilot: Abo nicht aktiv");
  if (r.status === 429) throw new HttpError(429, "SendPilot: zu viele Anfragen, gleich noch einmal");
  if (!r.ok) throw new Error(`SendPilot ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export async function sendpilotMe(key: string): Promise<{ id: string; name: string }> {
  const j = await sp(key, "/v1/me");
  return { id: j.workspace.id, name: j.workspace.name };
}

/* One JSON-RPC call to SendPilot's own MCP server (stateless, answers as JSON or a single SSE event) */
export async function sendpilotMcp<T = Record<string, unknown>>(key: string, method: string, params: object = {}): Promise<T> {
  const r = await fetch("https://mcp.sendpilot.ai", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json, text/event-stream" } });
  if (r.status === 401) throw new HttpError(400, "SendPilot: API-Schlüssel ungültig");
  if (r.status === 429) throw new HttpError(429, "SendPilot: zu viele Anfragen, gleich noch einmal");
  if (!r.ok) throw new Error(`SendPilot ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const text = await r.text();
  const j = JSON.parse(r.headers.get("content-type")?.includes("event-stream") ? text.split("\n").filter(l => l.startsWith("data:")).at(-1)!.slice(5) : text);
  if (j.error) throw new HttpError(400, `SendPilot: ${j.error.message}`);
  return j.result;
}

export async function sendpilotConfig(tenantId: number) {
  const c = await getInteg<SendPilotConfig>(tenantId, "sendpilot");
  if (!c) throw new HttpError(400, "SendPilot ist nicht verbunden");
  return c;
}

/* Campaigns that can take leads; finished ones are left out */
export async function sendpilotCampaigns(key: string): Promise<Campaign[]> {
  const out: Campaign[] = [];
  for (let page = 1; page <= 10; page++) {
    const j = await sp(key, `/v1/campaigns?limit=100&page=${page}`);
    out.push(...(j.campaigns || []).map((c: Campaign) => ({ id: c.id, name: c.name, status: c.status, totalLeads: c.totalLeads })));
    if (!j.pagination || page >= (j.pagination.totalPages ?? 1)) break;
  }
  return out.filter(c => !["finished", "failed"].includes(c.status));
}

export { linkedinKey };

/* Puts the tenant's leads into a campaign; leads without a profile URL or in the trash are skipped. SendPilot skips its own duplicates. */
export async function sendpilotPush(tenantId: number, campaignId: string, leadIds: number[]) {
  const { key } = await sendpilotConfig(tenantId);
  if (!leadIds.length) throw new HttpError(400, "Keine Leads ausgewählt");
  const rows = await db.select().from(leads).where(and(eq(leads.tenantId, tenantId), inArray(leads.id, leadIds), ne(leads.status, "papierkorb")));
  const blocked = await blockedOf(tenantId);
  const ok = rows.filter(l => linkedinKey(l.linkedin) && !l.crmAt && !blockedWhy(blocked, l));
  if (!ok.length) throw new HttpError(400, rows.some(l => linkedinKey(l.linkedin)) ? "Die Leads mit LinkedIn-Profil sind gesperrt oder registriert" : "Keiner der Leads hat ein LinkedIn-Profil");
  let added = 0, duplicates = 0, invalid = 0;
  for (let i = 0; i < ok.length; i += 1000) {
    const j = await sp(key, "/v1/leads", { method: "POST", body: JSON.stringify({ campaignId, leads: ok.slice(i, i + 1000).map(l => ({
      linkedinUrl: `https://www.linkedin.com/in/${linkedinKey(l.linkedin)}/`, firstName: l.first, lastName: l.last, company: l.company, title: l.role,
      ...(l.email ? { email: l.email } : {}), ...(l.website ? { website: l.website } : {}), ...(l.hook ? { hook: l.hook } : {}) })) }) });
    added += j.leadsAdded || 0; duplicates += j.duplicatesSkipped || 0; invalid += j.invalidEntries || 0;
  }
  /* from now on these people and their companies stay out of the mail run; mails still waiting for them are dropped */
  const sent = ok.map(l => l.id);
  await db.update(leads).set({ sendpilotAt: new Date() }).where(inArray(leads.id, sent));
  await db.delete(messages).where(and(eq(messages.tenantId, tenantId), inArray(messages.status, ["entwurf", "freigegeben"]),
    sql`(${messages.leadId} in (${sql.join(sent.map(id => sql`${id}`), sql`, `)}) or ${messages.leadIds} @> any(array[${sql.join(sent.map(id => sql`${JSON.stringify([id])}`), sql`, `)}]::jsonb[]))`));
  return { added, duplicates, invalid, skipped: rows.length - ok.length + (leadIds.length - rows.length) };
}

export type SendPilotEvent = { eventId: string; eventType: string; timestamp: string; workspaceId: string; data: { linkedinUrl?: string; reply?: string } };

/* Webhook events move the lead along: a first message or connection request counts as written to, a reply as answered.
   Statuses only go forward, so retried or late events change nothing. */
export async function sendpilotEvent(tenantId: number, ev: SendPilotEvent) {
  const handle = linkedinKey(ev.data?.linkedinUrl || "");
  if (!handle) return 0;
  const at = new Date(ev.timestamp || Date.now());
  const match = and(eq(leads.tenantId, tenantId), sql`lower(${leads.linkedin}) ~ ${`linkedin\\.com/in/${handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|\\?|#|$)`}`);
  if (ev.eventType === "reply.received") {
    const r = await db.update(leads).set({ status: sql`case when ${leads.status} in ('papierkorb', 'dublette') then ${leads.status} else 'beantwortet' end`, lastContactAt: at })
      .where(match).returning({ id: leads.id });
    return r.length;
  }
  if (ev.eventType === "message.sent" || ev.eventType === "connection_request.sent") {
    const r = await db.update(leads).set({ status: "angeschrieben", lastContactAt: at })
      .where(and(match, inArray(leads.status, ["neu", "freigabe"]))).returning({ id: leads.id });
    return r.length;
  }
  return 0;
}
