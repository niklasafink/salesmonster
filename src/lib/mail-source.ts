import { resolveMx } from "node:dns/promises";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { MailCursor } from "@/db";
import { getInteg } from "./integrations";
import { graphAccess } from "./mail";

/* One mailbox, read the same way whether it is Microsoft 365 or IMAP: pages of headers, then the latest bodies from one sender */
export type Addr = { email: string; name: string };
export type Head = { from: Addr | null; to: Addr[]; outgoing: boolean; bulk: boolean; date: Date };
export type Page = { heads: Head[]; cursor: MailCursor; done: boolean };
export type Source = { kind: "outlook" | "imap"; me: string; page(c: MailCursor, since: Date | null): Promise<Page>; bodies(from: string, n: number): Promise<string[]>; close(): Promise<void> };

const addr = (a?: { address?: string; name?: string } | null): Addr | null => a?.address ? { email: a.address.trim().toLowerCase(), name: (a.name || "").replace(/^["']|["']$/g, "").trim() } : null;
const addrs = (xs?: ({ address?: string; name?: string } | null | undefined)[] | null) => (xs || []).map(addr).filter((a): a is Addr => !!a);

type GraphMsg = { from?: { emailAddress?: { address?: string; name?: string } }; toRecipients?: { emailAddress?: { address?: string; name?: string } }[];
  ccRecipients?: { emailAddress?: { address?: string; name?: string } }[]; receivedDateTime?: string; inferenceClassification?: string; isDraft?: boolean };

async function graph(tenantId: number, userId: number): Promise<Source | null> {
  const g = await graphAccess(tenantId, userId);
  if (!g) return null;
  const me = g.email.toLowerCase();
  const get = async (url: string, prefer?: string) => {
    const tok = (await graphAccess(tenantId, userId))!.token;
    const r = await fetch(url, { headers: { authorization: `Bearer ${tok}`, ...(prefer ? { prefer } : {}) } });
    if (!r.ok) throw new Error(`Microsoft 365: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  return {
    kind: "outlook", me,
    /* all folders at once; "other" in Focused Inbox is Outlook's own newsletter and notification sorting */
    async page(c, since) {
      const first = `https://graph.microsoft.com/v1.0/me/messages?$top=500&$select=from,toRecipients,ccRecipients,receivedDateTime,inferenceClassification,isDraft`
        + (since ? `&$filter=${encodeURIComponent(`receivedDateTime gt ${since.toISOString()}`)}` : "");
      const j = await get(c.next || first) as { value: GraphMsg[]; "@odata.nextLink"?: string };
      const heads = j.value.filter(m => !m.isDraft).map(m => {
        const from = addr(m.from?.emailAddress);
        return { from, to: [...addrs(m.toRecipients?.map(x => x.emailAddress)), ...addrs(m.ccRecipients?.map(x => x.emailAddress))],
          outgoing: from?.email === me, bulk: m.inferenceClassification === "other", date: new Date(m.receivedDateTime || Date.now()) };
      });
      return { heads, cursor: { next: j["@odata.nextLink"] }, done: !j["@odata.nextLink"] };
    },
    /* uniqueBody is only what this mail added, without the quoted thread */
    async bodies(from, n) {
      const f = `receivedDateTime ge 1900-01-01T00:00:00Z and from/emailAddress/address eq '${from.replace(/'/g, "''")}'`;
      const j = await get(`https://graph.microsoft.com/v1.0/me/messages?$top=${n}&$orderby=receivedDateTime desc&$select=uniqueBody,body&$filter=${encodeURIComponent(f)}`,
        'outlook.body-content-type="text"') as { value: { uniqueBody?: { content?: string }; body?: { content?: string } }[] };
      return j.value.map(m => m.uniqueBody?.content || m.body?.content || "").filter(Boolean);
    },
    async close() {},
  };
}

/* IMAP host from the domain's mail exchanger; Microsoft 365 turned off IMAP passwords, so those mailboxes connect as Microsoft 365 */
const MX_HOSTS: [RegExp, string][] = [
  [/rzone\.de$/, "imap.strato.de"], [/(ionos|kundenserver|1and1|schlund)\./, "imap.ionos.de"], [/google(mail)?\.com$/, "imap.gmail.com"],
  [/gmx\.net$/, "imap.gmx.net"], [/web\.de$/, "imap.web.de"], [/t-online\.de$/, "secureimap.t-online.de"], [/hetzner\.(com|de)$|your-server\.de$/, "mail.your-server.de"],
  [/all-inkl\.com$|kasserver\.com$/, "w0.kasserver.com"], [/mailbox\.org$/, "imap.mailbox.org"], [/zoho\.(eu|com)$/, "imap.zoho.eu"],
];
export class Microsoft365 extends Error { constructor() { super("Dieses Postfach liegt bei Microsoft 365. Bitte Microsoft 365 verbinden."); } }

export async function imapHost(email: string) {
  const domain = email.split("@")[1]?.toLowerCase() || "";
  const mx = (await resolveMx(domain).catch(() => [])).sort((a, b) => a.priority - b.priority).map(m => m.exchange.toLowerCase());
  if (mx.some(m => /outlook\.com$/.test(m))) throw new Microsoft365();
  for (const m of mx) for (const [re, host] of MX_HOSTS) if (re.test(m)) return host;
  return `imap.${domain}`;
}

export type ImapConfig = { user: string; pass: string; host: string; port: string };
export const imapClient = (c: ImapConfig) => new ImapFlow({ host: c.host, port: Number(c.port) || 993, secure: Number(c.port || 993) !== 143,
  auth: { user: c.user, pass: c.pass }, logger: false, socketTimeout: 60_000 });

const HEADERS = ["list-unsubscribe", "list-id", "precedence", "auto-submitted"];
const BATCH = 1500;

async function imap(tenantId: number, userId: number): Promise<Source | null> {
  const c = await getInteg<ImapConfig>(tenantId, "imap", userId);
  if (!c) return null;
  const me = c.user.toLowerCase();
  const cl = imapClient(c);
  await cl.connect();
  return {
    kind: "imap", me,
    /* inbox and sent items, oldest unread uid first; a folder's max is fixed when it is first seen so a run ends */
    async page(cur) {
      let folders = cur.folders;
      if (!folders) {
        const list = await cl.list();
        const sent = list.find(f => f.specialUse === "\\Sent") || list.find(f => /^(sent|gesendet)/i.test(f.name));
        folders = [{ path: "INBOX", sent: false, uid: 0, max: 0 }, ...(sent ? [{ path: sent.path, sent: true, uid: 0, max: 0 }] : [])];
      }
      const f = folders.find(x => !x.max || x.uid < x.max);
      if (!f) return { heads: [], cursor: { folders: folders.map(x => ({ ...x, max: 0 })) }, done: true };
      const heads: Head[] = [];
      const lock = await cl.getMailboxLock(f.path);
      try {
        if (!f.max) f.max = Math.max(0, Number((cl.mailbox && cl.mailbox.uidNext) || 1) - 1);
        const to = Math.min(f.max, f.uid + BATCH);
        if (to > f.uid) for await (const m of cl.fetch(`${f.uid + 1}:${to}`, { uid: true, envelope: true, headers: HEADERS }, { uid: true })) {
          const from = addr(m.envelope?.from?.[0]);
          const h = m.headers?.toString("utf8").toLowerCase() || "";
          heads.push({ from, to: [...addrs(m.envelope?.to), ...addrs(m.envelope?.cc)], outgoing: f.sent || from?.email === me,
            bulk: /list-unsubscribe|list-id|precedence:\s*(bulk|list|junk)|auto-submitted:\s*auto/.test(h), date: new Date(m.envelope?.date || Date.now()) });
        }
        f.uid = to;
      } finally { lock.release(); }
      /* the next run starts from where this one ended */
      const done = folders.every(x => x.max && x.uid >= x.max);
      return { heads, cursor: { folders: done ? folders.map(x => ({ ...x, max: 0 })) : folders }, done };
    },
    async bodies(from, n) {
      const lock = await cl.getMailboxLock("INBOX");
      try {
        const uids = (await cl.search({ from }, { uid: true })) || [];
        const out: string[] = [];
        for (const uid of uids.slice(-n).reverse()) {
          const m = await cl.fetchOne(String(uid), { source: { maxLength: 200_000 } }, { uid: true });
          if (!m || !m.source) continue;
          const p = await simpleParser(m.source);
          out.push(p.text || "");
        }
        return out.filter(Boolean);
      } finally { lock.release(); }
    },
    async close() { await cl.logout().catch(() => {}); },
  };
}

/* Microsoft 365 first, IMAP second, like sending */
export async function openSource(tenantId: number, userId: number) {
  return await graph(tenantId, userId) || await imap(tenantId, userId);
}
