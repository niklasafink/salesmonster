import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db, suppressions } from "@/db";
import { domainOf } from "./hubspot";
import { validEmail } from "./lead-fields";

export type SupKind = "email" | "domain" | "linkedin";
export type Blocked = { email: Set<string>; domain: Set<string>; linkedin: Set<string> };
/* freemail domains are never blocked as a whole, only single addresses on them */
const FREEMAIL = new Set(["gmail.com", "googlemail.com", "web.de", "gmx.de", "gmx.net", "t-online.de", "outlook.com", "outlook.de", "hotmail.com", "hotmail.de", "yahoo.com", "yahoo.de", "icloud.com", "me.com", "live.com", "live.de", "aol.com", "freenet.de", "posteo.de", "mail.de", "proton.me", "protonmail.com"]);

/* linkedin.com/in/<handle> in one spelling, so the portal, the list and SendPilot agree on who is meant */
export function linkedinKey(url: string) {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(url || "");
  try { return m ? decodeURIComponent(m[1]).toLowerCase() : ""; } catch { return m ? m[1].toLowerCase() : ""; }
}

/* One line of the list as typed: an address, a profile link, or a domain (with or without www, http, @) */
export function parseEntry(raw: string): { kind: SupKind; value: string } | null {
  const s = raw.trim().replace(/^[<"']+|[>"',;]+$/g, "");
  if (!s) return null;
  if (validEmail(s)) return { kind: "email", value: s.toLowerCase() };
  const li = linkedinKey(s);
  if (li) return { kind: "linkedin", value: li };
  const d = domainOf(s.replace(/^@/, ""));
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && !FREEMAIL.has(d) ? { kind: "domain", value: d } : null;
}

export async function suppress(tenantId: number, entries: { kind: SupKind; value: string }[], reason: string, opts: { note?: string; userId?: number } = {}) {
  const rows = entries.filter(e => e.value).map(e => ({ tenantId, ...e, reason, note: opts.note || "", userId: opts.userId ?? null }));
  if (!rows.length) return 0;
  const got = await db.insert(suppressions).values(rows).onConflictDoNothing().returning({ id: suppressions.id });
  return got.length;
}

export const suppressEmail = (tenantId: number, email: string, reason: string, note = "") =>
  validEmail(email.trim()) ? suppress(tenantId, [{ kind: "email", value: email.trim().toLowerCase() }], reason, { note }) : Promise.resolve(0);

/* The whole list of a tenant as sets, read once per run */
export async function blockedOf(tenantId: number): Promise<Blocked> {
  const rows = await db.select({ kind: suppressions.kind, value: suppressions.value }).from(suppressions).where(eq(suppressions.tenantId, tenantId));
  const b: Blocked = { email: new Set(), domain: new Set(), linkedin: new Set() };
  for (const r of rows) b[r.kind as SupKind]?.add(r.value);
  return b;
}

/* Why a person may not be written to, or "" */
export function blockedWhy(b: Blocked, p: { email?: string; website?: string; linkedin?: string }) {
  const email = (p.email || "").trim().toLowerCase();
  if (email && b.email.has(email)) return "Adresse gesperrt";
  const doms = [email.split("@")[1], p.website ? domainOf(p.website) : ""].filter(Boolean);
  if (doms.some(d => b.domain.has(d!))) return "Domain gesperrt";
  const li = linkedinKey(p.linkedin || "");
  if (li && b.linkedin.has(li)) return "LinkedIn gesperrt";
  return "";
}

/* For a send: is any of these addresses blocked? */
export async function blockedAddresses(tenantId: number, to: string[]) {
  const emails = to.map(a => a.trim().toLowerCase()).filter(Boolean), doms = [...new Set(emails.map(a => a.split("@")[1]).filter(Boolean))];
  if (!emails.length) return [];
  const rows = await db.select({ kind: suppressions.kind, value: suppressions.value }).from(suppressions).where(and(eq(suppressions.tenantId, tenantId),
    or(and(eq(suppressions.kind, "email"), inArray(suppressions.value, emails)), doms.length ? and(eq(suppressions.kind, "domain"), inArray(suppressions.value, doms)) : undefined)));
  return emails.filter(a => rows.some(r => r.kind === "email" ? r.value === a : a.endsWith(`@${r.value}`)));
}

export async function listSuppressions(tenantId: number, q = "", limit = 200, offset = 0) {
  const where = and(eq(suppressions.tenantId, tenantId), q ? ilike(suppressions.value, `%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`) : undefined);
  const [rows, [{ n }]] = await Promise.all([
    db.select().from(suppressions).where(where).orderBy(desc(suppressions.createdAt), desc(suppressions.id)).limit(limit).offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(suppressions).where(where)]);
  return { total: n, rows };
}
