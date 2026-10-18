import Anthropic from "@anthropic-ai/sdk";
import nodemailer from "nodemailer";
import { Resend } from "resend";
import { HttpError, qp, route, tenantBySlug } from "@/lib/api";
import { INTEG, type IntegKind } from "@/lib/integ-meta";
import { removeInteg, setInteg } from "@/lib/integrations";
import { hubspotVerify } from "@/lib/hubspot";
import { sendpilotMe } from "@/lib/sendpilot";
import { MODEL } from "@/lib/claude";
import { OPENROUTER_MODELS, openrouterVerify } from "@/lib/ai";
import { Microsoft365, imapClient, imapHost } from "@/lib/mail-source";
import { startSync } from "@/lib/mail-sync";

/* Checks each credential before storing it */
async function verify(kind: IntegKind, v: Record<string, string>): Promise<string> {
  switch (kind) {
    case "claude": {
      try { await new Anthropic({ apiKey: v.key }).models.retrieve(MODEL); }
      catch (e) { if (e instanceof Anthropic.AuthenticationError) throw new HttpError(400, "API-Schlüssel ungültig"); throw e; }
      return MODEL;
    }
    case "openrouter": {
      if (!OPENROUTER_MODELS.some(([id]) => id === v.model)) throw new HttpError(400, "Modell unbekannt");
      const credit = await openrouterVerify(v.key).catch(() => { throw new HttpError(400, "API-Schlüssel ungültig"); });
      return [OPENROUTER_MODELS.find(([id]) => id === v.model)![1], credit].filter(Boolean).join(", ");
    }
    case "hubspot": return hubspotVerify(v.token).catch(() => { throw new HttpError(400, "Token ungültig oder ohne CRM-Rechte"); });
    case "sendpilot": {
      const ws = await sendpilotMe(v.key);
      v.workspace = ws.id;
      return ws.name;
    }
    case "resend": {
      if (!v.from) throw new HttpError(400, "Absender fehlt");
      const r = await new Resend(v.key).domains.list();
      if (r.error) throw new HttpError(400, `Resend: ${r.error.message}`);
      return `von ${v.from}`;
    }
    case "smtp": {
      const tr = nodemailer.createTransport({ host: v.host, port: Number(v.port) || 587, secure: Number(v.port) === 465, auth: { user: v.user, pass: v.pass } });
      await tr.verify().catch(e => { throw new HttpError(400, `SMTP: ${e.message}`); });
      return v.user;
    }
    case "imap": {
      if (!v.host) v.host = await imapHost(v.user).catch(e => { throw e instanceof Microsoft365 ? new HttpError(400, e.message) : e; });
      const cl = imapClient(v as { user: string; pass: string; host: string; port: string });
      await cl.connect().catch(e => { throw new HttpError(400, `IMAP ${v.host}: ${e.responseText || e.message}`); });
      await cl.logout().catch(() => {});
      return v.user;
    }
    default: throw new HttpError(400, "Nicht verfügbar");
  }
}

export const POST = route(async (req, _c, me) => {
  const { t: slug, kind, values } = await req.json() as { t: string; kind: IntegKind; values: Record<string, string> };
  const t = await tenantBySlug(slug, me);
  const meta = INTEG.find(i => i.k === kind);
  if (!meta || meta.auth !== "fields") throw new HttpError(400, "Nicht verfügbar");
  for (const f of meta.fields!) if (!f.optional && !String(values?.[f.id] || "").trim()) throw new HttpError(400, `${f.label} fehlt`);
  const clean = Object.fromEntries(meta.fields!.map(f => [f.id, String(values?.[f.id] ?? "").trim()]));
  const detail = await verify(kind, clean);
  await setInteg(t.id, kind, me.id, clean, detail);
  /* a connected mailbox is read into the contacts right away, like Attio */
  if (kind === "imap") await startSync(t.id, me.id, "imap");
});

export const DELETE = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  await removeInteg(t.id, qp(req, "kind") as IntegKind, me.id);
});
