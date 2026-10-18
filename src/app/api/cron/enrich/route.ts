import { after } from "next/server";
import { cronAuthorized } from "@/lib/api";
import { work } from "@/lib/enrich-jobs";
import { origin } from "@/lib/oauth";

export const maxDuration = 300;

/* The next stretch of a background enrich run; called by the run itself, answers at once and works after the response */
export async function POST(req: Request) {
  if (!cronAuthorized(req)) return new Response("Unauthorized", { status: 401 });
  const id = Number((await req.json().catch(() => ({}))).id);
  if (!Number.isSafeInteger(id) || id < 1) return new Response("Bad Request", { status: 400 });
  const base = origin(req);
  after(() => work(id, base).catch(e => console.error("enrich work", id, (e as Error).message)));
  return new Response(null, { status: 202 });
}
