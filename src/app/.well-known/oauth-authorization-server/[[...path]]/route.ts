import { CORS, authServerMetadata } from "@/lib/oauth";

export const GET = (req: Request) => Response.json(authServerMetadata(req), { headers: { ...CORS, "Cache-Control": "max-age=3600" } });

export const OPTIONS = () => new Response(null, { status: 204, headers: CORS });
