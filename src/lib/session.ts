import { SignJWT, jwtVerify } from "jose";

export const COOKIE = "sp_session";
const key = () => new TextEncoder().encode(`session:${process.env.APP_SECRET}`);

export async function signSession(userId: number) {
  return new SignJWT({ uid: userId }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("30d").sign(key());
}

export async function readSession(token: string | undefined): Promise<number | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key());
    return typeof payload.uid === "number" ? payload.uid : null;
  } catch {
    return null;
  }
}
