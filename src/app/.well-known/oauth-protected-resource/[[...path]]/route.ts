import { protectedResourceHandler } from "mcp-handler";
import { CORS, origin, resource } from "@/lib/oauth";

/* Root and path-suffixed form (/.well-known/oauth-protected-resource/api/mcp) answer the same */
export function GET(req: Request) {
  return protectedResourceHandler({ authServerUrls: [origin(req)], resourceUrl: resource(req) })(req);
}

export const OPTIONS = () => new Response(null, { status: 204, headers: CORS });
