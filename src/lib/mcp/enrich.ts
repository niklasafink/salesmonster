import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { db, leads, type EnrichField } from "@/db";
import { tenantBySlug } from "@/lib/api";
import { ENRICH_FIELDS, enrichContacts, type Filled } from "@/lib/enrich";
import { getInteg } from "@/lib/integrations";
import { hasField } from "@/lib/lead-fields";
import { later, refreshRatings } from "@/lib/ratings";
import { checkRun } from "@/lib/workflows";
import { tool } from "./tool";

/* leads per call: a SendPilot lookup waits for its search, so a call with ten stays well inside the time limit */
const MAX = 10;
const FIELDS = ENRICH_FIELDS as [EnrichField, ...EnrichField[]];

const HOW = "Recherchiere die Felder in todo je Lead selbst mit deiner Websuche (Firmenwebsite mit Team, Kontakt und Impressum, Pressemitteilungen, Branchenverzeichnisse, öffentliche Profile; "
  + "für linkedin das persönliche Profil linkedin.com/in/…, keine Firmenseite, und nur, wenn Name und Firma passen). Nimm nur Angaben, die du auf einer Quelle gesehen hast, und leite keine E-Mail aus einem Muster ab. "
  + "Schreib die Treffer mit leads_update (person als first/last mit salutation, dazu sourceUrl) und gib je Lead die Felder ohne Treffer als missed mit.";

export function enrichTools(server: McpServer) {
  tool(server, "leads_enrich", {
    description: "Reichert Leads an, ohne die KI des Portals zu bezahlen. Ist beim Mandanten SendPilot verbunden (tenants_list: sendpilot true), sucht das Portal das LinkedIn-Profil "
      + "(ohne bekannte Person auch Name und Funktion der Geschäftsführung) in der Lead-Datenbank von SendPilot und schreibt die Treffer gleich in den Lead; das kostet SendPilot-Credits (2 je gefundenem Lead). "
      + "Alles Übrige steht je Lead in todo: das recherchierst du selbst und schreibst es mit leads_update zurück (Anleitung in howTo). Ohne SendPilot steht alles in todo, auch linkedin. "
      + "Ohne ids nimmt es die neuesten Leads im Status neu, denen eins der Felder fehlt. Felder, die früher ohne Treffer blieben, nur mit again. Höchstens 10 Leads je Aufruf.",
    input: z.object({
      tenant: z.string().describe("Slug des Mandanten aus tenants_list"),
      fields: z.array(z.enum(FIELDS)).min(1).describe("Gesuchte Felder: person, role, email, phone, linkedin, website, city"),
      ids: z.array(z.number().int()).min(1).max(MAX).optional().describe("Bestimmte Leads (ids aus leads_list); ohne = die neuesten passenden"),
      again: z.boolean().default(false).describe("Auch Felder suchen, die früher ohne Treffer blieben"),
      run: z.number().int().optional().describe("runId aus workflow_start, wenn du einen Workflow ausführst; ohne Workflow weglassen"),
    }),
  }, async ({ tenant: slug, fields, ids, again, run: runId }, user) => {
    const t = await tenantBySlug(slug, user), wr = await checkRun(runId, t.id, "leads_update");
    const open = (l: typeof leads.$inferSelect) => fields.filter(f => !hasField(l, f) && (again || !l.enrichMiss[f]));
    const rows = ids
      ? await db.select().from(leads).where(and(eq(leads.tenantId, t.id), inArray(leads.id, ids)))
      : (await db.select().from(leads).where(and(eq(leads.tenantId, t.id), eq(leads.status, "neu"))).orderBy(desc(leads.createdAt), desc(leads.id)).limit(500))
        .filter(l => open(l).length).slice(0, MAX);
    const sp = !!(await getInteg(t.id, "sendpilot"));
    const done = new Map<number, { found: Filled; error?: string }>();
    if (sp && fields.includes("linkedin")) {
      /* SendPilot only, no paid web search; one lead per call so the lookups run side by side */
      const asks = fields.filter(f => f === "linkedin" || f === "person" || f === "role");
      await Promise.all(rows.filter(l => open(l).includes("linkedin") || open(l).includes("person")).map(async l => {
        try {
          const [r] = await enrichContacts(t.id, user.id, [l.id], asks, again, false);
          if (r) done.set(l.id, { found: r.found, ...(r.error ? { error: r.error } : {}) });
        } catch (e) { done.set(l.id, { found: {}, error: (e as Error).message }); }
      }));
      const changed = [...done].filter(([, d]) => Object.keys(d.found).length).map(([id]) => id);
      if (changed.length) await later(() => refreshRatings(t.id, changed));
    }
    /* read again: SendPilot may have filled fields and marked misses */
    const now = rows.length ? await db.select().from(leads).where(inArray(leads.id, rows.map(l => l.id))) : [];
    const byId = new Map(now.map(l => [l.id, l]));
    const out = rows.map(r => byId.get(r.id) ?? r).map(l => ({
      id: l.id, company: l.company, person: [l.salutation, l.first, l.last].filter(Boolean).join(" "), role: l.role, website: l.website, city: l.city, linkedin: l.linkedin,
      ...(done.has(l.id) ? { sendpilot: done.get(l.id) } : {}),
      todo: open(l),
    }));
    await wr?.count({ updated: [...done.values()].filter(d => Object.keys(d.found).length).length });
    return { via: sp && fields.includes("linkedin") ? "sendpilot" : "claude", leads: out, howTo: out.some(l => l.todo.length) ? HOW : "Nichts mehr offen." };
  });
}
