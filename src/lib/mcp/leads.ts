import { and, count, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { db, leads } from "@/db";
import { tenantBySlug } from "@/lib/api";
import { INFO_MAIL, addLeads } from "@/lib/lead-import";
import { setLeadStatus } from "@/lib/outreach";
import { tool } from "./tool";

const tenant = z.string().describe("Slug des Mandanten aus tenants_list");
const s = (d: string) => z.string().trim().optional().describe(d);

const newLead = z.object({
  company: z.string().trim().min(1).describe("Firmenname (Pflicht)"),
  person: s("Vor- und Nachname des Ansprechpartners, z. B. „Ida Muster“; leer lassen, wenn nur eine Firmenadresse bekannt ist"),
  role: s("Funktion des Ansprechpartners, z. B. Geschäftsführer"),
  email: s("E-Mail-Adresse; info@/kontakt@ usw. gelten als Firmenadresse"),
  website: s("Website, mit oder ohne https://"),
  city: s("Ort"),
});

const STATUS = ["neu", "freigabe", "angeschrieben", "beantwortet", "unzustellbar", "dublette"] as const;

const edit = z.object({
  id: z.number().int().describe("id aus leads_list"),
  company: s("Firmenname"), first: s("Vorname"), last: s("Nachname"), role: s("Funktion"), email: s("E-Mail-Adresse"),
  linkedin: s("LinkedIn-Profil-URL"), website: s("Website"), city: s("Ort"),
  hook: s("Aufhänger: konkreter Anlass für die erste Mail, z. B. eine passende Ausschreibung"), note: s("Notiz, z. B. Rechercheergebnis"),
  status: z.enum(STATUS).optional().describe("Neuer Status"),
});

const FIELDS = { id: leads.id, company: leads.company, first: leads.first, last: leads.last, role: leads.role, email: leads.email, emailType: leads.emailType,
  linkedin: leads.linkedin, website: leads.website, city: leads.city, hook: leads.hook, note: leads.note, status: leads.status, source: leads.source, createdAt: leads.createdAt };
const MISSING = { email: [leads.email], person: [leads.first, leads.last], role: [leads.role], website: [leads.website], linkedin: [leads.linkedin], city: [leads.city], hook: [leads.hook], note: [leads.note] };

export function leadTools(server: McpServer) {
  tool(server, "leads_list", {
    description: "Liest und sucht Leads des Mandanten, neueste zuerst. Felder: company (Firma), first/last (Vor-/Nachname), role, email, emailType (person = persönliche Adresse, info = Firmenadresse), "
      + "linkedin, website, city (Ort), hook (Aufhänger für die erste Mail), note (Notiz), status, source (Quelle). "
      + "Status: neu (noch nicht angeschrieben), freigabe (Entwurf wartet auf Freigabe), angeschrieben, beantwortet, unzustellbar, dublette. "
      + "Mit missing findest du Leads, denen ein Feld fehlt (z. B. email), um sie mit leads_update anzureichern. Rückgabe: total (Treffer gesamt) und rows; mit offset weiterblättern.",
    input: z.object({
      tenant,
      status: z.enum(STATUS).optional().describe("Nur Leads mit diesem Status"),
      query: s("Suchtext in Firma, Name, E-Mail, Ort, Website"),
      missing: z.enum(Object.keys(MISSING) as [keyof typeof MISSING]).optional().describe("Nur Leads, bei denen dieses Feld leer ist (person = kein Name)"),
      limit: z.number().int().min(1).max(200).default(50).describe("Höchstens 200, Standard 50"),
      offset: z.number().int().min(0).default(0),
    }),
  }, async ({ tenant: slug, status, query, missing, limit, offset }, user) => {
    const t = await tenantBySlug(slug, user), q = query && `%${query.replace(/[\\%_]/g, m => `\\${m}`)}%`;
    const where = and(eq(leads.tenantId, t.id), status && eq(leads.status, status), missing && and(...MISSING[missing].map(c => eq(c, ""))),
      q ? or(...[leads.company, leads.first, leads.last, leads.email, leads.city, leads.website].map(c => ilike(c, q))) : undefined) as SQL;
    const [{ n }] = await db.select({ n: count() }).from(leads).where(where);
    return { total: n, rows: await db.select(FIELDS).from(leads).where(where).orderBy(desc(leads.createdAt), desc(leads.id)).limit(limit).offset(offset) };
  });

  tool(server, "leads_add", {
    description: "Legt neue Leads im Mandanten an, z. B. aus einer hochgeladenen Excel- oder CSV-Datei: ordne die Spalten den Feldern zu (Firma → company, Ansprechpartner → person usw.). "
      + "Höchstens 200 Zeilen je Aufruf; größere Dateien in Teilen nacheinander schreiben und am Ende die Summe melden. "
      + "Duplikate werden wie beim Import im Portal übersprungen und mit Grund gemeldet: gleiche E-Mail („Schon in der Liste“), Kontakt schon in HubSpot, "
      + "oder bekannte Firma ohne E-Mail („Firma bekannt“). Ein weiterer Ansprechpartner mit eigener E-Mail bei einer bekannten Firma wird angelegt. "
      + "Rückgabe: added [{id, company}], skipped [{company, why}].",
    input: z.object({
      tenant,
      rows: z.array(newLead).min(1).max(200).describe("Die Leads, höchstens 200"),
      source: s("Quelle, die am Lead steht; Standard „Claude“"),
    }),
  }, async ({ tenant: slug, rows, source }, user) => {
    const t = await tenantBySlug(slug, user);
    return addLeads(t.id, rows.map(r => ({ co: r.company, p: r.person || "", role: r.role || "", email: r.email || "", web: r.website || "", city: r.city || "" })), source || "Claude");
  });

  tool(server, "leads_update", {
    description: "Reichert bestehende Leads des Mandanten an oder korrigiert sie (Felder wie bei leads_list). Nur Felder mit Inhalt werden geändert; leere oder weggelassene Felder bleiben, wie sie sind. "
      + "Höchstens 200 Leads je Aufruf, bei mehr in Teilen. Rückgabe: updated (geänderte ids) und notFound (ids, die es im Mandanten nicht gibt).",
    input: z.object({ tenant, updates: z.array(edit).min(1).max(200).describe("Je Lead die id und die neuen Werte") }),
  }, async ({ tenant: slug, updates }, user) => {
    const t = await tenantBySlug(slug, user);
    const found = new Map((await db.select({ id: leads.id, first: leads.first, last: leads.last }).from(leads)
      .where(and(eq(leads.tenantId, t.id), inArray(leads.id, updates.map(u => u.id))))).map(l => [l.id, l]));
    const updated: number[] = [], notFound: number[] = [];
    for (const { id, status, ...f } of updates) {
      const l = found.get(id);
      if (!l) { notFound.push(id); continue; }
      const set = Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as Partial<typeof leads.$inferInsert>;
      if (set.website && !set.website.startsWith("http")) set.website = `https://${set.website}`;
      if (set.email) set.emailType = INFO_MAIL.test(set.email) || !(set.first ?? l.first) && !(set.last ?? l.last) ? "info" : "person";
      if (Object.keys(set).length) await db.update(leads).set(set).where(eq(leads.id, id));
      if (status) await setLeadStatus(t.id, id, status);
      updated.push(id);
    }
    return { updated, notFound };
  });
}
