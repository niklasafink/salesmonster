import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { registerTools } from "@/lib/mcp";
import { INSTRUCTIONS } from "@/lib/mcp/instructions";
import { origin, verifyAccess } from "@/lib/oauth";

export const maxDuration = 300;

const mcp = createMcpHandler(registerTools, { serverInfo: { name: "Sales Monster", version: "1.0.0" }, instructions: INSTRUCTIONS });

function handler(req: Request) {
  return withMcpAuth(mcp, verifyAccess, { required: true, resourceUrl: origin(req), resourceMetadataPath: "/.well-known/oauth-protected-resource/api/mcp" })(req);
}

export { handler as GET, handler as POST, handler as DELETE };
