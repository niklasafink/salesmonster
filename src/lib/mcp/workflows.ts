import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { db, templates, workflowRuns, workflows } from "@/db";
import { HttpError, assertMember, tenantBySlug } from "@/lib/api";
import { WRITE_LABEL, runStatus } from "@/lib/workflows";
import { tool } from "./tool";

const tenant = z.string().describe("Slug des Mandanten aus tenants_list");
const WRITES_DOC = `Erlaubte Ergebnisse (writes): ${Object.entries(WRITE_LABEL).map(([k, v]) => `${k} = ${v}`).join(", ")}.`;
const firstSentence = (s: string) => s.trim().match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] ?? s.trim().split("\n")[0];

export function workflowTools(server: McpServer) {
  tool(server, "workflows_list", {
    description: `Listet die Workflows des Mandanten, neueste zuerst: id, name, writes, active, summary (erster Satz der Anweisung). Starten mit workflow_start. ${WRITES_DOC}`,
    input: z.object({ tenant }),
  }, async ({ tenant: slug }, user) => {
    const t = await tenantBySlug(slug, user);
    const rows = await db.select().from(workflows).where(eq(workflows.tenantId, t.id)).orderBy(desc(workflows.createdAt), desc(workflows.id));
    return rows.map(w => ({ id: w.id, name: w.name, writes: w.writes, active: w.active, summary: firstSentence(w.instructions) }));
  });

  tool(server, "workflow_start", {
    description: "Startet einen Workflow des Mandanten (per id oder Name) und legt im Portal einen Lauf an. Rückgabe: runId, instructions (die Anweisung, die du jetzt ausführst), "
      + "writes (was du ins Portal schreiben darfst), tenant (Name, Domain, researchPrompt = Recherche-Prompt mit Zielgruppe, leadsPerDay, aktive Mail-Vorlagen) und next. "
      + `Gib bei jedem Schreib-Tool run = runId mit; am Ende run_finish mit Bericht aufrufen. Inaktive Workflows lassen sich nicht starten. ${WRITES_DOC}`,
    input: z.object({ tenant, workflow: z.union([z.number().int(), z.string().trim().min(1)]).describe("id oder Name des Workflows aus workflows_list") }),
  }, async ({ tenant: slug, workflow }, user) => {
    const t = await tenantBySlug(slug, user);
    const all = await db.select().from(workflows).where(eq(workflows.tenantId, t.id)).orderBy(desc(workflows.createdAt));
    const w = typeof workflow === "number" ? all.find(x => x.id === workflow) : all.find(x => x.name.trim().toLowerCase() === workflow.toLowerCase());
    if (!w) throw new HttpError(404, "Workflow nicht gefunden");
    if (!w.active) throw new HttpError(409, `Workflow „${w.name}“ ist inaktiv`);
    const [run] = await db.insert(workflowRuns).values({ workflowId: w.id, tenantId: t.id, userId: user.id }).returning({ id: workflowRuns.id });
    const tpls = await db.select({ key: templates.key, name: templates.name, tone: templates.tone, subject: templates.subject }).from(templates)
      .where(and(eq(templates.tenantId, t.id), eq(templates.active, true))).orderBy(asc(templates.key));
    return {
      runId: run.id, workflow: { id: w.id, name: w.name }, instructions: w.instructions, writes: w.writes,
      tenant: { slug: t.slug, name: t.name, domain: t.domain, researchPrompt: t.settings.prompt, leadsPerDay: t.settings.leadsPerDay, templates: tpls },
      next: `Gib bei leads_add, leads_update und templates_save immer run: ${run.id} mit. Schreibe nur, was writes erlaubt (${w.writes.map(k => WRITE_LABEL[k]).join(", ") || "nichts"}). `
        + `Rufe am Ende run_finish mit run: ${run.id} auf${w.writes.includes("report") ? " und lege dort einen Bericht in Markdown ab" : ""}.`,
    };
  });

  tool(server, "run_finish", {
    description: "Schließt einen Lauf ab, den workflow_start angelegt hat. report: Bericht in Markdown (was gefunden, angelegt, übersprungen wurde; nur wenn der Workflow einen Bericht erlaubt). "
      + "status: fertig (Standard) oder abgebrochen, wenn du die Aufgabe nicht zu Ende bringen konntest.",
    input: z.object({
      run: z.number().int().describe("runId aus workflow_start"),
      report: z.string().optional().describe("Bericht in Markdown"),
      status: z.enum(["fertig", "abgebrochen"]).default("fertig"),
    }),
  }, async ({ run, report, status }, user) => {
    const [row] = await db.select({ r: workflowRuns, w: workflows }).from(workflowRuns).leftJoin(workflows, eq(workflows.id, workflowRuns.workflowId)).where(eq(workflowRuns.id, run));
    if (!row) throw new HttpError(404, "Lauf nicht gefunden");
    await assertMember(user, row.r.tenantId, "Lauf");
    if (runStatus(row.r) !== "läuft") throw new HttpError(409, `Lauf ist ${runStatus(row.r)}`);
    if (report?.trim() && !row.w?.writes.includes("report")) throw new HttpError(403, "Der Workflow erlaubt keinen Bericht; run_finish ohne report aufrufen");
    await db.update(workflowRuns).set({ status, report: report?.trim() || "", finishedAt: new Date() }).where(eq(workflowRuns.id, run));
    return { run, status, counts: row.r.counts };
  });
}
