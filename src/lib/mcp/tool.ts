import { eq } from "drizzle-orm";
import type { CallToolResult, McpServer, ServerContext, StandardSchemaWithJSON, ToolCallback } from "@modelcontextprotocol/server";
import { db, users } from "@/db";
import { HttpError } from "@/lib/api";

export type McpUser = typeof users.$inferSelect;

/* The person behind the access token (set by verifyAccess); loaded fresh so deleted users stop at once */
export async function mcpUser(ctx: ServerContext): Promise<McpUser> {
  const uid = ctx.http?.authInfo?.extra?.userId;
  const [u] = typeof uid === "number" ? await db.select().from(users).where(eq(users.id, uid)) : [];
  if (!u) throw new HttpError(401, "Nicht angemeldet");
  return u;
}

/* Registers a tool whose handler gets the parsed args and the current user and returns plain data (sent as JSON text).
   HttpError (e.g. from tenantBySlug) becomes a tool error with its message. */
export function tool<S extends StandardSchemaWithJSON>(server: McpServer, name: string, def: { description: string; input: S },
  fn: (args: StandardSchemaWithJSON.InferOutput<S>, user: McpUser) => Promise<unknown>) {
  const cb = async (args: StandardSchemaWithJSON.InferOutput<S>, ctx: ServerContext): Promise<CallToolResult> => {
    try {
      const out = await fn(args, await mcpUser(ctx));
      return { content: [{ type: "text", text: JSON.stringify(out ?? { ok: true }) }] };
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : "Fehler" }] };
    }
  };
  server.registerTool(name, { description: def.description, inputSchema: def.input }, cb as ToolCallback<S>);
}
