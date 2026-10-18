import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { db, members, tenants } from "@/db";
import { tool } from "./tool";

export function tenantTools(server: McpServer) {
  tool(server, "tenants_list", {
    description: "Listet die Mandanten (Unternehmen) des angemeldeten Nutzers mit Slug, Name und Domain. Der Slug ist der Parameter `tenant` der anderen Tools.",
    input: z.object({}),
  }, async (_, user) => db.select({ slug: tenants.slug, name: tenants.name, domain: tenants.domain }).from(tenants)
    .innerJoin(members, and(eq(members.tenantId, tenants.id), eq(members.userId, user.id))).orderBy(asc(tenants.name)));
}
