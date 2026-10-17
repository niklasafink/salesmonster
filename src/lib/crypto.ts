import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const key = () => createHash("sha256").update(`secrets:${process.env.APP_SECRET}`).digest();

export function encrypt(obj: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map(b => b.toString("base64")).join(".");
}

export function decrypt<T = Record<string, string>>(s: string): T {
  const [iv, tag, data] = s.split(".").map(x => Buffer.from(x, "base64"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString("utf8"));
}

export function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return `${salt.toString("base64")}:${scryptSync(pw, salt, 64).toString("base64")}`;
}

export function checkPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(":");
  const a = scryptSync(pw, Buffer.from(salt, "base64"), 64), b = Buffer.from(hash, "base64");
  return a.length === b.length && timingSafeEqual(a, b);
}
