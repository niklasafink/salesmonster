import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { HttpError, tenantBySlug } from "@/lib/api";
import { getInteg } from "@/lib/integrations";
import { startSync, stepSync, syncState } from "@/lib/mail-sync";
import { tool } from "./tool";

const tenant = z.string().describe("Slug des Mandanten aus tenants_list; jeder Mandant hat sein eigenes Postfach");

export function mailTools(server: McpServer) {
  tool(server, "mail_sync_status", {
    description: "Stand des Postfach-Abgleichs des Nutzers in diesem Mandanten: status (läuft, fertig, fehler), phase (scan = E-Mails lesen, signatur = Signaturen auswerten, import = ins CRM übernehmen), "
      + "scanned (gelesene E-Mails), contacts (Personen mit echtem Austausch), imported (davon im CRM). null, wenn noch nie abgeglichen. Die Kontakte stehen danach in leads_list mit status kontakt.",
    input: z.object({ tenant }),
  }, async (args, user) => syncState((await tenantBySlug(args.tenant, user)).id, user.id));

  tool(server, "mail_sync_run", {
    description: "Liest das Postfach des Nutzers in diesem Mandanten ins CRM: alle Personen, mit denen E-Mails ausgetauscht wurden, mit Name, Firma, Rolle, Telefon, Website und LinkedIn aus ihrer Signatur. "
      + "Ohne Newsletter, Systemadressen und Kollegen der eigenen Domain. Jeder Aufruf arbeitet bis zu 50 Sekunden; so lange erneut aufrufen, bis status nicht mehr läuft. "
      + "Ein zweiter Lauf liest nur neue E-Mails seit dem letzten.",
    input: z.object({ tenant }),
  }, async (args, user) => {
    const t = await tenantBySlug(args.tenant, user);
    const cur = await syncState(t.id, user.id);
    if (cur?.status !== "läuft") {
      const src = await getInteg(t.id, "outlook", user.id) ? "outlook" : await getInteg(t.id, "imap", user.id) ? "imap" : null;
      if (!src) throw new HttpError(400, `In ${t.name} ist kein Postfach verbunden. Im Portal unter Einstellungen → Integrationen Microsoft 365 oder IMAP verbinden.`);
      await startSync(t.id, user.id, src);
    }
    return stepSync(t.id, user.id, 50_000);
  });
}
