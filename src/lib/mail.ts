import { createHash, createHmac } from "node:crypto";
import nodemailer from "nodemailer";
import { Resend } from "resend";
import { getInteg, setInteg } from "./integrations";

export type Attachment = { filename: string; content: Buffer; contentType: string };
export type Mail = { to: string; subject: string; text: string; attachments?: Attachment[] };

type Graph = { access: string; refresh: string; exp: number; email: string };

/* The portal's Azure app "Sales Monster". It is a public client: the id is not secret, the code exchange is protected by PKCE,
   so there is no client secret to store. MS_CLIENT_ID/MS_CLIENT_SECRET still override it for a confidential app */
const MS_APP = "7ac57562-ec92-4f26-8eba-874e84498e56";
export const msClientId = () => process.env.MS_CLIENT_ID || MS_APP;
export const msConfigured = () => !!msClientId();
export const stateKey = () => new TextEncoder().encode(`ms:${process.env.APP_SECRET}`);
export const MS_SCOPES = "offline_access User.Read Mail.Send Mail.Read";

/* PKCE verifier derived from the state's nonce, so nothing has to be stored between redirect and callback */
export const msVerifier = (nonce: string) => createHmac("sha256", `pkce:${process.env.APP_SECRET}`).update(nonce).digest("base64url");
export const msChallenge = (nonce: string) => createHash("sha256").update(msVerifier(nonce)).digest("base64url");

export async function msToken(body: Record<string, string>) {
  const r = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: msClientId(), ...(process.env.MS_CLIENT_SECRET ? { client_secret: process.env.MS_CLIENT_SECRET } : {}), scope: MS_SCOPES, ...body }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || "Microsoft-Anmeldung fehlgeschlagen");
  return j as { access_token: string; refresh_token: string; expires_in: number };
}

export async function graphAccess(tenantId: number, userId: number): Promise<{ token: string; email: string } | null> {
  const g = await getInteg<Graph>(tenantId, "outlook", userId);
  if (!g) return null;
  if (g.exp > Date.now() + 60_000) return { token: g.access, email: g.email };
  const t = await msToken({ grant_type: "refresh_token", refresh_token: g.refresh });
  const next = { ...g, access: t.access_token, refresh: t.refresh_token || g.refresh, exp: Date.now() + t.expires_in * 1000 };
  await setInteg(tenantId, "outlook", userId, next, g.email);
  return { token: next.access, email: g.email };
}

/* Sends from the person's own mailbox: Microsoft 365 first, SMTP second */
export async function sendAs(tenantId: number, userId: number, m: Mail): Promise<string> {
  const g = await graphAccess(tenantId, userId);
  if (g) {
    const r = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
      method: "POST", headers: { authorization: `Bearer ${g.token}`, "content-type": "application/json" },
      body: JSON.stringify({ saveToSentItems: true, message: {
        subject: m.subject, body: { contentType: "Text", content: m.text },
        toRecipients: m.to.split(/,\s*/).filter(Boolean).map(address => ({ emailAddress: { address } })),
        attachments: (m.attachments || []).map(a => ({ "@odata.type": "#microsoft.graph.fileAttachment", name: a.filename, contentType: a.contentType, contentBytes: a.content.toString("base64") })),
      } }),
    });
    if (!r.ok) throw new Error(`Microsoft 365: ${(await r.text()).slice(0, 200)}`);
    return g.email;
  }
  const s = await getInteg(tenantId, "smtp", userId);
  if (s) {
    const tr = nodemailer.createTransport({ host: s.host, port: Number(s.port) || 587, secure: Number(s.port) === 465, auth: { user: s.user, pass: s.pass } });
    await tr.sendMail({ from: s.user, to: m.to, subject: m.subject, text: m.text, attachments: m.attachments });
    return s.user;
  }
  throw new Error("Kein Postfach verbunden");
}

export async function mailboxOf(tenantId: number, userId: number) {
  const g = await getInteg<Graph>(tenantId, "outlook", userId);
  if (g) return g.email;
  const s = await getInteg(tenantId, "smtp", userId);
  return s?.user || null;
}

/* System mail (approval reminder) */
export async function sendSystem(tenantId: number, m: Mail) {
  const r = await getInteg(tenantId, "resend");
  if (!r) throw new Error("Resend ist nicht verbunden");
  const res = await new Resend(r.key).emails.send({ from: r.from, to: m.to, subject: m.subject, text: m.text,
    attachments: m.attachments?.map(a => ({ filename: a.filename, content: a.content })) });
  if (res.error) throw new Error(res.error.message);
}

/* Replies since sentAt from a given address, via Microsoft Graph */
export async function hasReply(tenantId: number, userId: number, from: string, since: Date) {
  const g = await graphAccess(tenantId, userId);
  if (!g) return null;
  const f = `from/emailAddress/address eq '${from.replace(/'/g, "''")}' and receivedDateTime ge ${since.toISOString()}`;
  const r = await fetch(`https://graph.microsoft.com/v1.0/me/messages?$top=1&$select=id&$filter=${encodeURIComponent(f)}`, { headers: { authorization: `Bearer ${g.token}` } });
  if (!r.ok) return null;
  const j = await r.json();
  return (j.value || []).length > 0;
}

/* Delivery failure for an address since a date: a bounce from the mail system that names the address */
export async function hasBounce(tenantId: number, userId: number, to: string, since: Date) {
  const g = await graphAccess(tenantId, userId);
  if (!g) return null;
  const q = encodeURIComponent(`"${to.replace(/"/g, "")}"`);
  const r = await fetch(`https://graph.microsoft.com/v1.0/me/messages?$top=10&$select=from,receivedDateTime&$search=${q}`, { headers: { authorization: `Bearer ${g.token}` } });
  if (!r.ok) return null;
  const j = await r.json() as { value?: { from?: { emailAddress?: { address?: string } }; receivedDateTime: string }[] };
  return (j.value || []).some(m => new Date(m.receivedDateTime) >= since && /mailer-daemon|postmaster|microsoftexchange/i.test(m.from?.emailAddress?.address || ""));
}
