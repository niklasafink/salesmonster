import type { McpServer } from "@modelcontextprotocol/server";
import { tenantTools } from "./tenants";

/* One function per tool group (one file each); new groups are added here */
export function registerTools(server: McpServer) {
  tenantTools(server);
}
