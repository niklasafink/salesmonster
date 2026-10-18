import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { db, templates } from "@/db";
import { HttpError, tenantBySlug } from "@/lib/api";
import { PLACEHOLDERS } from "@/lib/fill";
import { lint } from "@/lib/playbook";
import { checkRun } from "@/lib/workflows";
import { tool } from "./tool";

const tenant = z.string().describe("Slug des Mandanten aus tenants_list");

export function templateTools(server: McpServer) {
  tool(server, "templates_list", {
    description: "Listet alle Mail-Vorlagen des Mandanten nach key: key, name, tone (sie/du), subject, body, active, origin, "
      + "score (Jev-Bewertung: reply = Antwortchance 0–4, weakness = größte Schwäche; null = noch nicht bewertet).",
    input: z.object({ tenant }),
  }, async ({ tenant: slug }, user) => {
    const t = await tenantBySlug(slug, user);
    const rows = await db.select().from(templates).where(eq(templates.tenantId, t.id)).orderBy(asc(templates.key));
    return rows.map(x => ({ key: x.key, name: x.name, tone: x.tone, subject: x.subject, body: x.body, active: x.active, origin: x.origin,
      score: x.score ? { reply: x.score.reply, weakness: x.score.weakness } : null }));
  });

  tool(server, "templates_save", {
    description: "Legt eine Mail-Vorlage an oder überarbeitet sie (Upsert per key). Neue Vorlagen kommen inaktiv an (Herkunft „Claude“) und werden erst versendet, "
      + "wenn jemand sie im Portal prüft und aktiviert; überarbeitete behalten ihren Aktiv-Status, ihre Jev-Bewertung wird zurückgesetzt. "
      + "Platzhalter: {{anrede}} (fertige Grußzeile mit Komma, z. B. „Guten Tag Frau Muster,“ bzw. bei du „Hallo Anna,“), {{firma}}, {{vorname}}, {{nachname}}, "
      + "{{aufhaenger}} (Anlass/Hook des Leads) bzw. bei Mandanten mit Ausschreibungen {{ausschreibungen}} (Liste der gefundenen Ausschreibungen), {{absender}} (Name des Absenders). "
      + "Andere Platzhalter werden abgelehnt. Rückgabe: key, created, active, hints (Hinweise aus der Prüfung: Länge, Betreff, fehlende Pflicht-Platzhalter, Links). "
      + "Im Workflow-Lauf run mitgeben.",
    input: z.object({
      tenant,
      key: z.string().trim().min(1).max(20).describe("Kennung der Variante, z. B. A, B, C; bestehender key = überarbeiten"),
      name: z.string().trim().min(1).describe("Kurzer Name, zwei Wörter"),
      tone: z.enum(["sie", "du"]).describe("Ansprache"),
      subject: z.string().trim().min(1), body: z.string().trim().min(1),
      run: z.number().int().optional().describe("runId aus workflow_start"),
    }),
  }, async ({ tenant: slug, key, name, tone, subject, body, run }, user) => {
    const t = await tenantBySlug(slug, user);
    const wr = await checkRun(run, t.id, "templates");
    const allowed = PLACEHOLDERS(t.tenders);
    const unknown = [...new Set([...`${subject} ${body}`.matchAll(/{{\s*([^}]*)}}/g)].map(m => m[0]))].filter(p => !allowed.includes(p));
    if (unknown.length) throw new HttpError(400, `Unbekannte Platzhalter: ${unknown.join(", ")}. Erlaubt: ${allowed.join(", ")}`);
    const hints = lint(subject, body, ["{{anrede}}", "{{absender}}", t.tenders ? "{{ausschreibungen}}" : "{{aufhaenger}}"]);
    const v = { name, tone, subject, body, score: null };
    /* xmax = 0 only for a freshly inserted row */
    const [r] = await db.insert(templates).values({ tenantId: t.id, key, ...v, active: false, origin: "Claude" })
      .onConflictDoUpdate({ target: [templates.tenantId, templates.key], set: v })
      .returning({ active: templates.active, created: sql<boolean>`(xmax = 0)` });
    await wr?.count({ templates: 1 });
    return { key, created: r.created, active: r.active, hints };
  });
}
