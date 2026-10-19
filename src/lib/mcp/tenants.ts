import { and, asc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { db, integrations, members, tenants } from "@/db";
import { aiFor, choiceLabel } from "@/lib/ai";
import { tool } from "./tool";

export function tenantTools(server: McpServer) {
  tool(server, "tenants_list", {
    description: "Listet die Mandanten (Unternehmen) des angemeldeten Nutzers mit Slug, Name und Domain. Der Slug ist der Parameter `tenant` der anderen Tools. "
      + "Jeder Mandant hat eigene Integrationen: hubspot (nur dann gleichen Leads mit HubSpot ab), mailbox (Postfach des Nutzers in diesem Mandanten, Quelle für Kontakte), ai (KI, die das Portal für diesen Mandanten nutzt), sendpilot (LinkedIn über die sendpilot_*-Tools: Leads aus dem Portal mit sendpilot_push in Kampagnen geben, dazu Kampagnen, Inbox, Absender und Lead-Suche). "
      + "Daten eines Mandanten nie in einen anderen schreiben.",
    input: z.object({}),
  }, async (_, user) => {
    const ts = await db.select({ id: tenants.id, slug: tenants.slug, name: tenants.name, domain: tenants.domain, settings: tenants.settings }).from(tenants)
      .innerJoin(members, and(eq(members.tenantId, tenants.id), eq(members.userId, user.id))).orderBy(asc(tenants.name));
    const ints = await db.select({ tenantId: integrations.tenantId, kind: integrations.kind, detail: integrations.detail }).from(integrations)
      .where(or(isNull(integrations.userId), eq(integrations.userId, user.id)));
    return Promise.all(ts.map(async t => {
      const on = (k: string) => ints.find(i => i.tenantId === t.id && i.kind === k);
      const ai = await aiFor(t.id, user.id);
      return { slug: t.slug, name: t.name, domain: t.domain, hubspot: !!on("hubspot"), sendpilot: !!on("sendpilot"), mailbox: on("outlook")?.detail || on("imap")?.detail || null,
        ai: t.settings.ai ? choiceLabel(t.settings.ai) : ai ? (typeof ai === "object" && ai.provider === "openrouter" ? `${ai.model} über OpenRouter` : "Claude Sonnet 5.5") : null };
    }));
  });
}
