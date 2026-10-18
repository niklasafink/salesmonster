import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { tenantBySlug } from "@/lib/api";
import { sendpilotCampaigns, sendpilotConfig, sendpilotPush } from "@/lib/sendpilot";
import { tool } from "./tool";

const tenant = z.string().describe("Slug des Mandanten aus tenants_list; SendPilot ist je Mandant verbunden");

export function sendpilotTools(server: McpServer) {
  tool(server, "sendpilot_campaigns", {
    description: "Listet die LinkedIn-Kampagnen in SendPilot, die noch Leads aufnehmen (id, name, status, totalLeads). Nur für Mandanten, bei denen tenants_list sendpilot true zeigt.",
    input: z.object({ tenant }),
  }, async (args, user) => sendpilotCampaigns((await sendpilotConfig((await tenantBySlug(args.tenant, user)).id)).key));

  tool(server, "sendpilot_push", {
    description: "Gibt Leads aus dem Portal (ids aus leads_list) in eine SendPilot-Kampagne; SendPilot schreibt sie dann auf LinkedIn an. Leads ohne LinkedIn-Profil oder im Papierkorb werden übersprungen, "
      + "Dubletten überspringt SendPilot. Antwort: added, duplicates, invalid, skipped. Antworten auf LinkedIn setzen den Lead später auf beantwortet. Vor dem Aufruf Kampagne und Leads mit dem Nutzer abstimmen.",
    input: z.object({ tenant, campaignId: z.string().describe("id aus sendpilot_campaigns"), leadIds: z.array(z.number().int()).min(1).max(1000) }),
  }, async (args, user) => sendpilotPush((await tenantBySlug(args.tenant, user)).id, args.campaignId, args.leadIds));
}
