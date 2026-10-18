import type { McpServer } from "@modelcontextprotocol/server";
import { leadTools } from "./leads";
import { tenantTools } from "./tenants";
import { workflowTools } from "./workflows";

/* One function per tool group (one file each); new groups are added here */
export function registerTools(server: McpServer) {
  tenantTools(server);
  leadTools(server);
  workflowTools(server);
}
