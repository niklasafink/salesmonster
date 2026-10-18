import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { db, templates } from "@/db";
import { HttpError, tenantBySlug } from "@/lib/api";
import { PLACEHOLDERS } from "@/lib/fill";
import { lint, nextKey, unknownPlaceholders } from "@/lib/playbook";
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
    description: "Legt eine Mail-Vorlage an oder überarbeitet sie. Neue Vorlagen kommen inaktiv an (Herkunft „Claude“) und werden erst versendet, "
      + "wenn jemand sie im Portal prüft und aktiviert. Eine inaktive Vorlage mit diesem key wird überarbeitet (bleibt inaktiv, Jev-Bewertung zurückgesetzt). "
      + "Eine aktive Vorlage wird nie verändert: stattdessen entsteht eine inaktive Kopie mit deinem Text unter dem nächsten freien key (copyOf = der angefragte key). "
      + "Platzhalter: {{anrede}} (fertige Grußzeile mit Komma, z. B. „Guten Tag Frau Muster,“ bzw. bei du „Hallo Anna,“), {{firma}}, {{vorname}}, {{nachname}}, "
      + "{{aufhaenger}} (Anlass/Hook des Leads) bzw. bei Mandanten mit Ausschreibungen {{ausschreibungen}} (Liste der gefundenen Ausschreibungen), {{absender}} (Name des Absenders). "
      + "Andere Platzhalter werden abgelehnt. Rückgabe: key (der tatsächlich gespeicherte), created, active, copyOf (nur bei Kopie), hints (Hinweise aus der Prüfung: Länge, Betreff, fehlende Pflicht-Platzhalter, Links). "
      + "Im Workflow-Lauf run mitgeben.",
    input: z.object({
      tenant,
      key: z.string().trim().min(1).max(20).describe("Kennung der Variante, z. B. A, B, C; bestehender inaktiver key = überarbeiten, aktiver = Kopie"),
      name: z.string().trim().min(1).describe("Kurzer Name, zwei Wörter"),
      tone: z.enum(["sie", "du"]).describe("Ansprache"),
      subject: z.string().trim().min(1), body: z.string().trim().min(1),
      run: z.number().int().optional().describe("runId aus workflow_start"),
    }),
  }, async ({ tenant: slug, key, name, tone, subject, body, run }, user) => {
    const t = await tenantBySlug(slug, user);
    const wr = await checkRun(run, t.id, "templates");
    const allowed = PLACEHOLDERS(t.tenders);
    const unknown = unknownPlaceholders(`${subject} ${body}`, allowed);
    if (unknown.length) throw new HttpError(400, `Unbekannte Platzhalter: ${unknown.join(", ")}. Erlaubt: ${allowed.join(", ")}`);
    const hints = lint(subject, body, ["{{anrede}}", "{{absender}}", t.tenders ? "{{ausschreibungen}}" : "{{aufhaenger}}"]);
    const v = { name, tone, subject, body, score: null }, fresh = { tenantId: t.id, ...v, active: false, origin: "Claude" };
    const rows = await db.select({ key: templates.key, active: templates.active }).from(templates).where(eq(templates.tenantId, t.id));
    const cur = rows.find(x => x.key === key);
    /* a live template only changes when a person decides so in the portal */
    if (cur?.active) {
      const copy = nextKey(new Set(rows.map(x => x.key)));
      await db.insert(templates).values({ ...fresh, key: copy });
      await wr?.count({ templates: 1 });
      return { key: copy, created: true, active: false, copyOf: key, hints };
    }
    /* setWhere: should it have been activated in the meantime, nothing is overwritten and the call fails */
    const [r] = await db.insert(templates).values({ ...fresh, key })
      .onConflictDoUpdate({ target: [templates.tenantId, templates.key], set: v, setWhere: eq(templates.active, false) })
      .returning({ key: templates.key });
    if (!r) throw new HttpError(409, `Vorlage ${key} wurde gerade aktiviert, bitte erneut speichern`);
    await wr?.count({ templates: 1 });
    return { key, created: !cur, active: false, hints };
  });
}
