import { eq } from "drizzle-orm";
import { db, users } from "@/db";
import { HttpError, route } from "@/lib/api";
import { checkPassword, hashPassword } from "@/lib/crypto";

export const POST = route(async (req, _c, u) => {
  const { current, next } = await req.json();
  if (!checkPassword(String(current || ""), u.passwordHash)) throw new HttpError(400, "Aktuelles Passwort stimmt nicht");
  if (String(next || "").length < 10) throw new HttpError(400, "Mindestens 10 Zeichen");
  await db.update(users).set({ passwordHash: hashPassword(next) }).where(eq(users.id, u.id));
});
