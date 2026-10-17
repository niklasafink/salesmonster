import { cookies } from "next/headers";
import { COOKIE } from "@/lib/session";

export async function POST() {
  (await cookies()).delete(COOKIE);
  return Response.json({ ok: true });
}
