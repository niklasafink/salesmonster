import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db, users } from "@/db";
import { checkPassword } from "@/lib/crypto";
import { COOKIE, signSession } from "@/lib/session";

export async function POST(req: Request) {
  const { email, password } = await req.json();
  const [u] = await db.select().from(users).where(eq(users.email, String(email || "").trim().toLowerCase()));
  if (!u || !checkPassword(String(password || ""), u.passwordHash)) return Response.json({ error: "E-Mail oder Passwort falsch" }, { status: 401 });
  (await cookies()).set(COOKIE, await signSession(u.id), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 30 * 864e2 });
  return Response.json({ ok: true });
}
