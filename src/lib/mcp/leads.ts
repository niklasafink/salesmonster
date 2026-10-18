import { and, count, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { db, leads } from "@/db";
import { attachCompanies } from "@/lib/companies";
import { cleanLead, emailTypeOf, websiteOf } from "@/lib/lead-fields";
import { tenantBySlug } from "@/lib/api";
import { addLeads } from "@/lib/lead-import";
import { setLeadStatus } from "@/lib/outreach";
import { checkRun } from "@/lib/workflows";
import { tool } from "./tool";

const tenant = z.string().describe("Slug des Mandanten aus tenants_list");
const run = z.number().int().optional().describe("runId aus workflow_start, wenn du einen Workflow ausführst; ohne Workflow weglassen");
const s = (d: string) => z.string().trim().optional().describe(d);

const SAL = "Anrede mit Titel: Herr, Frau, Herr Dr., Frau Dr., Herr Prof. Dr. oder Frau Prof. Dr."

const newLead = z.object({
  company: z.string().trim().min(1).describe("Firmenname (Pflicht); mehrere Ansprechpartner derselben Firma als je eine Zeile mit gleichem Firmennamen"),
  salutation: s(`${SAL}; weglassen, wenn unbekannt (dann wird sie wenn möglich aus Vorname und Funktion ergänzt)`),
  person: s("Vor- und Nachname des Ansprechpartners ohne Anrede und Titel, z. B. „Ida Muster“; leer lassen, wenn nur eine Firmenadresse bekannt ist"),
  role: s("Funktion des Ansprechpartners, z. B. Geschäftsführer"),
  email: s("E-Mail-Adresse; info@/kontakt@ usw. gelten als Firmenadresse"),
  website: s("Website, mit oder ohne https://"),
  city: s("Ort"),
  linkedin: s("LinkedIn-Profil-URL"),
  hook: s("Aufhänger: konkreter Anlass für die erste Mail als Substantivgruppe, z. B. „die neue Niederlassung in Halle“"),
  sourceUrl: s("URL, unter der die Angaben gefunden wurden"),
});

const STATUS = ["neu", "freigabe", "angeschrieben", "beantwortet", "unzustellbar", "dublette", "kontakt"] as const;

const edit = z.object({
  id: z.number().int().describe("id aus leads_list"),
  company: s("Firmenname; ein anderer Name ordnet den Kontakt dieser Firma zu"), salutation: s(SAL), first: s("Vorname"), last: s("Nachname"), role: s("Funktion"), email: s("E-Mail-Adresse"),
  linkedin: s("LinkedIn-Profil-URL"), website: s("Website"), phone: s("Telefon"), city: s("Ort"),
  hook: s("Aufhänger: konkreter Anlass für die erste Mail, z. B. eine passende Ausschreibung"), note: s("Notiz"),
  sourceUrl: s("URL, unter der die Angaben gefunden wurden"), research: s("Rechercheergebnis als Text"),
  status: z.enum(STATUS).optional().describe("Neuer Status"),
});

const FIELDS = { id: leads.id, companyId: leads.companyId, company: leads.company, salutation: leads.salutation, first: leads.first, last: leads.last, role: leads.role, email: leads.email, emailType: leads.emailType,
  linkedin: leads.linkedin, website: leads.website, phone: leads.phone, lastContactAt: leads.lastContactAt, city: leads.city, hook: leads.hook, note: leads.note, status: leads.status, source: leads.source, sourceUrl: leads.sourceUrl, createdAt: leads.createdAt };
const MISSING = { email: [leads.email], person: [leads.first, leads.last], role: [leads.role], website: [leads.website], salutation: [leads.salutation], linkedin: [leads.linkedin], city: [leads.city], hook: [leads.hook], note: [leads.note] };

export function leadTools(server: McpServer) {
  tool(server, "leads_list", {
    description: "Liest und sucht Leads (Kontakte) des Mandanten, neueste zuerst. Jeder Lead ist ein Ansprechpartner einer Firma; companyId verbindet die Kontakte derselben Firma. "
      + "Felder: companyId, company (Firma), salutation (Anrede mit Titel, z. B. „Frau Dr.“), first/last (Vor-/Nachname), role, email, emailType (person = persönliche Adresse, info = Firmenadresse), "
      + "linkedin, website, phone (Telefon aus der Signatur), lastContactAt (letzte E-Mail), city (Ort), hook (Aufhänger für die erste Mail), note (Notiz), status, source (Quelle), sourceUrl (Fundstelle). "
      + "Status: neu (noch nicht angeschrieben), freigabe (Entwurf wartet auf Freigabe), angeschrieben, beantwortet, unzustellbar, dublette, kontakt (bestehender Kontakt aus dem Postfach, wird nie kalt angeschrieben). "
      + "Mit missing findest du Leads, denen ein Feld fehlt (z. B. email), um sie mit leads_update anzureichern. Rückgabe: total (Treffer gesamt) und rows; mit offset weiterblättern.",
    input: z.object({
      tenant,
      status: z.enum(STATUS).optional().describe("Nur Leads mit diesem Status"),
      query: s("Suchtext in Firma, Name, E-Mail, Ort, Website"),
      companyId: z.number().int().optional().describe("Nur die Kontakte dieser Firma"),
      missing: z.enum(Object.keys(MISSING) as [keyof typeof MISSING]).optional().describe("Nur Leads, bei denen dieses Feld leer ist (person = kein Name)"),
      limit: z.number().int().min(1).max(200).default(50).describe("Höchstens 200, Standard 50"),
      offset: z.number().int().min(0).default(0),
    }),
  }, async ({ tenant: slug, status, query, companyId, missing, limit, offset }, user) => {
    const t = await tenantBySlug(slug, user), q = query && `%${query.replace(/[\\%_]/g, m => `\\${m}`)}%`;
    const where = and(eq(leads.tenantId, t.id), status && eq(leads.status, status), companyId !== undefined ? eq(leads.companyId, companyId) : undefined, missing && and(...MISSING[missing].map(c => eq(c, ""))),
      q ? or(...[leads.company, leads.first, leads.last, leads.email, leads.city, leads.website].map(c => ilike(c, q))) : undefined) as SQL;
    const [{ n }] = await db.select({ n: count() }).from(leads).where(where);
    return { total: n, rows: await db.select(FIELDS).from(leads).where(where).orderBy(desc(leads.createdAt), desc(leads.id)).limit(limit).offset(offset) };
  });

  tool(server, "leads_add", {
    description: "Legt neue Leads (Kontakte) im Mandanten an, z. B. aus einer hochgeladenen Excel- oder CSV-Datei: ordne die Spalten den Feldern zu (Firma → company, Ansprechpartner → person usw.). "
      + "Kontakte mit gleichem Firmennamen (ohne Rechtsform verglichen) kommen zur selben Firma, auch zu einer schon vorhandenen. "
      + "Höchstens 200 Zeilen je Aufruf; größere Dateien in Teilen nacheinander schreiben und am Ende die Summe melden. "
      + "Duplikate werden wie beim Import im Portal übersprungen und mit Grund gemeldet: gleiche E-Mail („Schon in der Liste“), Kontakt schon in HubSpot, "
      + "oder bekannte Firma ohne E-Mail („Firma bekannt“); ist HubSpot gerade nicht erreichbar, wird die Zeile mit „HubSpot nicht erreichbar“ übersprungen und kann später erneut kommen. Ein weiterer Ansprechpartner mit eigener E-Mail bei einer bekannten Firma wird angelegt. "
      + "Rückgabe: added [{id, company, companyId}], skipped [{company, why}].",
    input: z.object({
      tenant,
      rows: z.array(newLead).min(1).max(200).describe("Die Leads, höchstens 200"),
      source: s("Quelle, die am Lead steht; Standard „Claude“, im Workflow dessen Name"),
      run,
    }),
  }, async ({ tenant: slug, rows, source, run: runId }, user) => {
    const t = await tenantBySlug(slug, user), wr = await checkRun(runId, t.id, "leads_add");
    const out = await addLeads(t.id, rows.map(r => ({ co: r.company, sal: r.salutation, p: r.person || "", role: r.role || "", email: r.email || "", web: r.website || "", city: r.city || "", li: r.linkedin, hook: r.hook, url: r.sourceUrl })), source || wr?.workflow || "Claude");
    await wr?.count({ added: out.added.length, skipped: out.skipped.length });
    return out;
  });

  tool(server, "leads_update", {
    description: "Reichert bestehende Leads des Mandanten an oder korrigiert sie (Felder wie bei leads_list, dazu research). Ein neuer Firmenname ordnet den Kontakt der Firma mit diesem Namen zu (oder einer neuen). Nur Felder mit Inhalt werden geändert; leere oder weggelassene Felder bleiben, wie sie sind. "
      + "Höchstens 200 Leads je Aufruf, bei mehr in Teilen. Rückgabe: updated (geänderte ids) und notFound (ids, die es im Mandanten nicht gibt).",
    input: z.object({ tenant, updates: z.array(edit).min(1).max(200).describe("Je Lead die id und die neuen Werte"), run }),
  }, async ({ tenant: slug, updates, run: runId }, user) => {
    const t = await tenantBySlug(slug, user), wr = await checkRun(runId, t.id, "leads_update");
    const found = new Map((await db.select({ id: leads.id, company: leads.company, first: leads.first, last: leads.last, email: leads.email }).from(leads)
      .where(and(eq(leads.tenantId, t.id), inArray(leads.id, updates.map(u => u.id))))).map(l => [l.id, l]));
    const updated: number[] = [], notFound: number[] = [];
    let moved = false;
    for (const { id, status, ...f } of updates) {
      const l = found.get(id);
      if (!l) { notFound.push(id); continue; }
      const set: Partial<typeof leads.$inferInsert> = Object.fromEntries(Object.entries(cleanLead(f)).filter(([, v]) => v));
      if (set.website) set.website = websiteOf(set.website);
      if (set.email || set.first || set.last) set.emailType = emailTypeOf(set.email ?? l.email, !!((set.first ?? l.first) || (set.last ?? l.last)));
      if (set.company && set.company !== l.company) { set.companyId = null; moved = true; }
      if (Object.keys(set).length) await db.update(leads).set(set).where(eq(leads.id, id));
      if (status) await setLeadStatus(t.id, id, status);
      updated.push(id);
    }
    if (moved) await attachCompanies(t.id);
    await wr?.count({ updated: updated.length });
    return { updated, notFound };
  });
}
