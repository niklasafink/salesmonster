import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db, users } from "@/db";
import { body, fail, HttpError } from "@/lib/api";
import { hashPassword } from "@/lib/crypto";
import { acceptInvite, checkInvite } from "@/lib/invites";
import { validEmail } from "@/lib/lead-fields";
import { COOKIE, signSession } from "@/lib/session";

export async function POST(req: Request) {
  try {
    const b = await body(req);
    const name = String(b.name || "").trim().slice(0, 80), email = String(b.email || "").trim().toLowerCase(), password = String(b.password || "");
    if (!name) throw new HttpError(400, "Name angeben");
    if (!validEmail(email)) throw new HttpError(400, "E-Mail ungültig");
    if (password.length < 10) throw new HttpError(400, "Passwort: mindestens 10 Zeichen");
    const [have] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (have) throw new HttpError(400, "Für diese E-Mail gibt es schon ein Konto");
    if (b.invite) await checkInvite(String(b.invite));
    const [u] = await db.insert(users).values({ email, name, short: name.split(/\s+/)[0], passwordHash: hashPassword(password) }).returning();
    if (b.invite) await acceptInvite(String(b.invite), u.id);
    (await cookies()).set(COOKIE, await signSession(u.id), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 30 * 864e2 });
    return Response.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
