import Anthropic from "@anthropic-ai/sdk";
import nodemailer from "nodemailer";
import { Resend } from "resend";
import { HttpError, qp, route, tenantBySlug } from "@/lib/api";
import { INTEG, type IntegKind } from "@/lib/integ-meta";
import { removeInteg, setInteg } from "@/lib/integrations";
import { hubspotVerify } from "@/lib/hubspot";
import { sendpilotMe } from "@/lib/sendpilot";
import { MODEL } from "@/lib/claude";
import { AI_ENV, OPENROUTER_MODELS, modelsVerify, openrouterVerify } from "@/lib/ai";
import { Microsoft365, imapClient, imapHost, smtpHost } from "@/lib/mail-source";
import { startSync } from "@/lib/mail-sync";

/* Checks each credential before storing it */
async function verify(kind: IntegKind, v: Record<string, string>): Promise<string> {
  switch (kind) {
    case "claude": {
      try { await new Anthropic({ apiKey: v.key, baseURL: AI_ENV.claude.base }).models.retrieve(MODEL); }
      catch (e) { if (e instanceof Anthropic.AuthenticationError) throw new HttpError(400, "API-Schlüssel ungültig"); throw e; }
      return MODEL;
    }
    case "openrouter": {
      if (!OPENROUTER_MODELS.some(([id]) => id === v.model)) throw new HttpError(400, "Modell unbekannt");
      const credit = await openrouterVerify(v.key).catch(() => { throw new HttpError(400, "API-Schlüssel ungültig"); });
      return [OPENROUTER_MODELS.find(([id]) => id === v.model)![1], credit].filter(Boolean).join(", ");
    }
    case "requesty": case "openai": {
      await modelsVerify(kind, v.key).catch(() => { throw new HttpError(400, "API-Schlüssel ungültig"); });
      return "";
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

/* One mailbox = IMAP for reading and SMTP for sending, entered once; servers follow from the address unless given */
async function mailbox(v: Record<string, string>) {
  const user = String(v?.user || "").trim(), pass = String(v?.pass || "").trim();
  if (!user) throw new HttpError(400, "E-Mail fehlt");
  if (!pass) throw new HttpError(400, "Passwort fehlt");
  const imap = { user, pass, port: "993", host: String(v.host || "").trim() };
  if (!imap.host) imap.host = await imapHost(user).catch(e => { throw e instanceof Microsoft365 ? new HttpError(400, e.message) : e; });
  const cl = imapClient(imap);
  await cl.connect().catch(e => { throw new HttpError(400, `IMAP ${imap.host}: ${e.responseText || e.message}`); });
  await cl.logout().catch(() => {});
  const host = String(v.smtp || "").trim() || smtpHost(imap.host);
  let last: Error | null = null;
  for (const port of [465, 587]) {
    try {
      await nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass }, connectionTimeout: 10_000 }).verify();
      return { imap, smtp: { host, port: String(port), user, pass } };
    } catch (e) { last = e as Error; }
  }
  throw new HttpError(400, `SMTP ${host}: ${last?.message}`);
}

export const POST = route(async (req, _c, me) => {
  const { t: slug, kind, values } = await req.json() as { t: string; kind: IntegKind | "mailbox"; values: Record<string, string> };
  const t = await tenantBySlug(slug, me);
  if (kind === "mailbox") {
    const m = await mailbox(values);
    await setInteg(t.id, "imap", me.id, m.imap, m.imap.user);
    /* the SMTP host tells the settings screen which provider the mailbox belongs to */
    await setInteg(t.id, "smtp", me.id, m.smtp, m.smtp.host);
    await startSync(t.id, me.id, "imap");
    return;
  }
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
  const kind = qp(req, "kind");
  for (const k of kind === "mailbox" ? ["imap", "smtp"] as const : [kind as IntegKind]) await removeInteg(t.id, k, me.id);
});
