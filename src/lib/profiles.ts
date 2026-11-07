import { and, asc, eq, inArray } from "drizzle-orm";
import { db, leads, profiles, templates } from "@/db";
import { HttpError } from "./api";

export type ProfileRow = typeof profiles.$inferSelect;

/* The tenant's profiles, default first; a tenant without any gets its default ("Allgemein") on first read */
export async function listProfiles(tenantId: number): Promise<ProfileRow[]> {
  let rows = await db.select().from(profiles).where(eq(profiles.tenantId, tenantId)).orderBy(asc(profiles.id));
  if (!rows.some(p => p.isDefault)) {
    await db.insert(profiles).values({ tenantId, name: rows.some(p => p.name === "Allgemein") ? "Allgemein (Standard)" : "Allgemein", isDefault: true }).onConflictDoNothing();
    rows = await db.select().from(profiles).where(eq(profiles.tenantId, tenantId)).orderBy(asc(profiles.id));
  }
  return [...rows.filter(p => p.isDefault), ...rows.filter(p => !p.isDefault)];
}

/* What a lead or template stores for a chosen profile: null for the default, else the id. Accepts the id or the name (MCP).
   undefined in, undefined out: nothing chosen, nothing changed. */
export async function profileRef(tenantId: number, v: unknown): Promise<number | null | undefined> {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const list = await listProfiles(tenantId);
  const p = typeof v === "number" ? list.find(x => x.id === v) : typeof v === "string" ? list.find(x => x.name.toLowerCase() === v.trim().toLowerCase()) : undefined;
  if (!p) throw new HttpError(400, `Unbekanntes Profil: ${String(v)}`);
  return p.isDefault ? null : p.id;
}

export async function createProfile(tenantId: number, name: string, audience = "") {
  const n = name.trim().slice(0, 80);
  if (!n) throw new HttpError(400, "Name fehlt");
  const list = await listProfiles(tenantId);
  if (list.some(p => p.name.toLowerCase() === n.toLowerCase())) throw new HttpError(400, `Profil „${n}“ gibt es schon`);
  const [p] = await db.insert(profiles).values({ tenantId, name: n, audience: audience.trim().slice(0, 4000) }).returning();
  return p;
}

/* Puts leads of this tenant into a profile; ids of other tenants are ignored */
export async function assignProfile(tenantId: number, ids: number[], profileId: number | null) {
  if (!ids.length) return [];
  return (await db.update(leads).set({ profileId }).where(and(eq(leads.tenantId, tenantId), inArray(leads.id, ids))).returning({ id: leads.id })).map(r => r.id);
}

/* Profiles that have at least one active template; leads of the others wait in the list and are not drafted */
export async function sendableProfiles(tenantId: number) {
  const rows = await db.selectDistinct({ p: templates.profileId }).from(templates).where(and(eq(templates.tenantId, tenantId), eq(templates.active, true)));
  return new Set(rows.map(r => r.p));
}
