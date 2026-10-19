import type { McpServer } from "@modelcontextprotocol/server";
import { leadTools } from "./leads";
import { mailTools } from "./mail";
import { sendpilotTools } from "./sendpilot";
import { templateTools } from "./templates";
import { tenantTools } from "./tenants";
import { workflowTools } from "./workflows";

/* One function per tool group (one file each); new groups are added here */
export async function registerTools(server: McpServer) {
  tenantTools(server);
  leadTools(server);
  templateTools(server);
  workflowTools(server);
  mailTools(server);
  await sendpilotTools(server);
}
