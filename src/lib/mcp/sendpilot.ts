import { z } from "zod";
import { eq } from "drizzle-orm";
import { fromJsonSchema, type CallToolResult, type McpServer, type Tool } from "@modelcontextprotocol/server";
import { db, integrations } from "@/db";
import { publicError, tenantBySlug } from "@/lib/api";
import { decrypt } from "@/lib/crypto";
import { sendpilotCampaigns, sendpilotConfig, sendpilotMcp, sendpilotPush } from "@/lib/sendpilot";
import { mcpUser, tool } from "./tool";

const tenant = z.string().describe("Slug des Mandanten aus tenants_list; SendPilot ist je Mandant verbunden");

/* add_leads would bypass the portal (sendpilotAt keeps those leads out of the mail run), sendpilot_push does it right */
const SKIP = new Set(["add_leads"]);

/* SendPilot's tool list, fetched with any stored key (the list is the same for every workspace) and kept for an hour */
let cache: { at: number; tools: Tool[] } | undefined;
async function remoteTools(): Promise<Tool[]> {
  if (cache && Date.now() - cache.at < 3600_000) return cache.tools;
  try {
    const [row] = await db.select({ config: integrations.config }).from(integrations).where(eq(integrations.kind, "sendpilot")).limit(1);
    if (!row) return [];
    const { tools } = await sendpilotMcp<{ tools: Tool[] }>(decrypt<{ key: string }>(row.config).key, "tools/list");
    cache = { at: Date.now(), tools: tools.filter(t => !SKIP.has(t.name)) };
    return cache.tools;
  } catch (e) {
    console.error("SendPilot tools/list", e);
    return cache?.tools ?? [];
  }
}

export async function sendpilotTools(server: McpServer) {
  tool(server, "sendpilot_campaigns", {
    description: "Listet die LinkedIn-Kampagnen in SendPilot, die noch Leads aufnehmen (id, name, status, totalLeads). Nur für Mandanten, bei denen tenants_list sendpilot true zeigt.",
    input: z.object({ tenant }),
  }, async (args, user) => sendpilotCampaigns((await sendpilotConfig((await tenantBySlug(args.tenant, user)).id)).key));

  tool(server, "sendpilot_push", {
    description: "Gibt Leads aus dem Portal (ids aus leads_list) in eine SendPilot-Kampagne; SendPilot schreibt sie dann auf LinkedIn an. Leads ohne LinkedIn-Profil, im Papierkorb, auf der Sperrliste oder auf der Website registriert werden übersprungen, "
      + "Dubletten überspringt SendPilot. Antwort: added, duplicates, invalid, skipped. Antworten auf LinkedIn setzen den Lead später auf beantwortet. Vor dem Aufruf Kampagne und Leads mit dem Nutzer abstimmen.",
    input: z.object({ tenant, campaignId: z.string().describe("id aus sendpilot_campaigns"), leadIds: z.array(z.number().int()).min(1).max(1000) }),
  }, async (args, user) => sendpilotPush((await tenantBySlug(args.tenant, user)).id, args.campaignId, args.leadIds));

  /* Everything else SendPilot's own MCP offers (inbox, senders, lead search, …), called with the key the tenant stored in the portal */
  for (const t of await remoteTools()) {
    const schema = { ...t.inputSchema, properties: { tenant: { type: "string", description: tenant.description }, ...t.inputSchema.properties },
      required: ["tenant", ...(t.inputSchema.required ?? [])] };
    server.registerTool(`sendpilot_${t.name}`, { title: t.title ?? t.annotations?.title, description: `SendPilot: ${t.description}`, annotations: t.annotations,
      inputSchema: fromJsonSchema<{ tenant: string } & Record<string, unknown>>(schema as Parameters<typeof fromJsonSchema>[0]) },
    async ({ tenant: slug, ...args }, ctx): Promise<CallToolResult> => {
      try {
        const { key } = await sendpilotConfig((await tenantBySlug(slug, await mcpUser(ctx))).id);
        return await sendpilotMcp<CallToolResult>(key, "tools/call", { name: t.name, arguments: args });
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: publicError(e).message }] };
      }
    });
  }
}
