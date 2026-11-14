/* LinkedIn worker for the portal's own campaigns (src/lib/linkedin.ts). Runs on the owner's Mac, no browser: it talks to LinkedIn's internal
   web API (Voyager, the one linkedin.com itself uses) with the owner's session cookie, from the owner's own IP.
   It asks the portal for one action at a time, does it and reports back.
   Rule: once the send request went out, the outcome is "gesendet" (LinkedIn said yes) or "unklar", never "fehler", so nothing is sent twice.

   node bridge/linkedin.mjs login          paste the li_at cookie once, checks it and stores it
   node bridge/linkedin.mjs probe <url>    shows what the worker reads for a profile, sends nothing
   node bridge/linkedin.mjs run [--once]   works the queue
   Config: ~/.salesmonster/linkedin.env (LI_API, LI_TOKEN, LI_AT, optional LI_UA = the user agent of your Chrome) */
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const HOME = join(homedir(), ".salesmonster");
const ENV_FILE = process.env.LI_ENV || join(HOME, "linkedin.env");
const readEnv = () => existsSync(ENV_FILE) ? Object.fromEntries(readFileSync(ENV_FILE, "utf8").split("\n")
  .map(l => /^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/.exec(l)).filter(Boolean).map(m => [m[1], m[2]])) : {};
const ENV = { ...readEnv(), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("LI_"))) };
const API = (ENV.LI_API || "").replace(/\/$/, "");
const UA = ENV.LI_UA || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const VERSION = "linkedin-worker 2 (api)";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const human = (min = 1500, max = 4000) => sleep(min + Math.random() * (max - min));
const log = (...a) => console.log(new Date().toLocaleString("de-DE"), ...a);
const norm = s => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

/* ---------- portal ---------- */

async function portal(path, body) {
  const r = await fetch(`${API}/api/linkedin/worker/${path}`, { method: "POST", headers: { authorization: `Bearer ${ENV.LI_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Portal ${r.status}: ${j.error || "ohne Text"}`);
  return j;
}

/* ---------- LinkedIn session ---------- */

/* LinkedIn's own endpoints; undocumented, so they live here in one place. Profile ids are the ACoA… member ids. */
const LI = "https://www.linkedin.com";
const EP = {
  me: "/voyager/api/me",
  profile: h => `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(h)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-16`,
  networkInfo: h => `/voyager/api/identity/profiles/${encodeURIComponent(h)}/networkinfo`,
  sentInvites: start => `/voyager/api/relationships/sentInvitationViewsV2?count=100&invitationType=CONNECTION&q=invitationType&start=${start}`,
  invite: "/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2",
  conversations: id => `/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX&q=participants&recipients=List(${encodeURIComponent(id)})`,
  events: conv => `/voyager/api/messaging/conversations/${encodeURIComponent(conv)}/events`,
  send: "/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage",
};

class LoggedOut extends Error {}
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const keep = r => { for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(";"); const i = kv.indexOf("="); const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim(); if (k && v && v !== '""' && k !== "li_at") jar.set(k, v); } };

/* li_at from the env; JSESSIONID (= the csrf token) and the other cookies come from a first plain page request, like a browser gets them */
async function session(liAt = ENV.LI_AT) {
  if (!liAt) throw new Error(`LI_AT fehlt in ${ENV_FILE}: npm run li:login`);
  jar.clear(); jar.set("li_at", liAt);
  const r = await fetch(`${LI}/feed/`, { redirect: "manual", headers: { "user-agent": UA, cookie: cookieHeader(), accept: "text/html" } });
  keep(r);
  if (!jar.get("JSESSIONID")) throw new Error("LinkedIn hat keine Sitzung (JSESSIONID) geliefert");
  if (r.status >= 300 && r.status < 400 && /login|authwall|checkpoint/.test(r.headers.get("location") || "")) throw new LoggedOut("li_at abgelaufen");
}

/* one call; status and parsed body, never throws on HTTP errors (the caller decides), throws LoggedOut when the session is gone */
async function li(path, init = {}) {
  const csrf = (jar.get("JSESSIONID") || "").replace(/"/g, "");
  const r = await fetch(`${LI}${path}`, { ...init, redirect: "manual", headers: { "user-agent": UA, cookie: cookieHeader(), "csrf-token": csrf,
    accept: "application/vnd.linkedin.normalized+json+2.1", "x-restli-protocol-version": "2.0.0", "x-li-lang": "de_DE", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  keep(r);
  const text = await r.text();
  if (r.status === 401 || r.status === 999 || (r.status >= 300 && r.status < 400)) throw new LoggedOut(r.status === 999 ? "LinkedIn blockt die Anfragen (999)" : `abgemeldet (${r.status})`);
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, ok: r.status >= 200 && r.status < 300, json, text };
}

/* ---------- reading ---------- */

const IDS = /urn:li:(?:fsd_profile|fs_miniProfile|fs_profile|member):(ACoA[A-Za-z0-9_-]+)/;

async function me() {
  const r = await li(EP.me);
  if (!r.ok) throw new Error(`me ${r.status}`);
  const id = IDS.exec(r.text)?.[1];
  const mp = (r.json?.included || []).find(x => x.firstName) || r.json?.miniProfile || {};
  return { id, name: [mp.firstName, mp.lastName].filter(Boolean).join(" ") };
}

/* member id, whether connected (1st degree) and whether an invite of ours is open */
async function readProfile(handle) {
  const p = await li(EP.profile(handle));
  if (p.status === 404) return { missing: true };
  if (!p.ok) throw new Error(`Profil ${p.status}`);
  const first = p.json?.data?.["*elements"]?.[0] || p.json?.elements?.[0]?.entityUrn || "";
  const id = IDS.exec(first)?.[1] || IDS.exec(p.text)?.[1];
  if (!id) return { missing: true };
  await human(600, 1500);
  const n = await li(EP.networkInfo(handle));
  const distance = n.json?.distance?.value || n.json?.data?.distance?.value || /"DISTANCE_[0-9A-Z_]+"/.exec(n.text)?.[0]?.replace(/"/g, "") || "";
  const connected = distance === "DISTANCE_1" || (!distance && /"connection"\s*:\s*\{/.test(p.text));
  return { id, distance, connected, pending: connected ? false : await pending(id, handle) };
}

/* our open invites, read once per run of checks (a few pages at most) */
let sentCache = { at: 0, text: "" };
async function pending(id, handle) {
  if (Date.now() - sentCache.at > 10 * 60_000) {
    let text = "";
    for (let start = 0; start < 500; start += 100) {
      const r = await li(EP.sentInvites(start));
      if (!r.ok) throw new Error(`offene Anfragen ${r.status}`);
      text += r.text;
      if (!r.text.includes("ACoA") || (r.json?.data?.elements || r.json?.elements || []).length < 100) break;
      await human(500, 1200);
    }
    sentCache = { at: Date.now(), text };
  }
  return sentCache.text.includes(id) || sentCache.text.includes(`"${handle}"`);
}

/* every message in the thread with the person: who wrote it (their id or not) and the text; null = could not be read */
async function readThread(theirId) {
  const c = await li(EP.conversations(theirId));
  if (!c.ok) return null;
  const urn = /urn:li:(?:fs_conversation|msg_conversation):([^"),]+)/.exec(c.text)?.[1];
  /* no thread only when LinkedIn lists none; an answer we do not understand counts as unreadable, so nothing is sent on a guess */
  const listed = c.json?.elements ?? c.json?.data?.elements ?? c.json?.data?.["*elements"];
  if (!urn) return Array.isArray(listed) && listed.length === 0 ? { messages: [] } : null;
  await human(500, 1200);
  const e = await li(EP.events(urn));
  if (!e.ok) return null;
  const all = [...(e.json?.included || []), ...(e.json?.elements || []), ...(e.json?.data?.elements || [])];
  const messages = [];
  for (const x of all) {
    const body = x?.eventContent?.attributedBody?.text ?? x?.eventContent?.["com.linkedin.voyager.messaging.event.MessageEvent"]?.attributedBody?.text ?? x?.body?.text;
    if (typeof body !== "string") continue;
    const from = JSON.stringify(x.from ?? x["*from"] ?? x.sender ?? "");
    messages.push({ theirs: from.includes(theirId), text: body, at: x.createdAt || 0 });
  }
  /* a thread exists, so it has messages; none found means the format changed */
  if (!messages.length) return null;
  return { messages: messages.sort((a, b) => a.at - b.at) };
}

/* ---------- actions ---------- */

const rejected = r => `${r.status}: ${(r.json?.data?.message || r.json?.message || r.text || "").toString().slice(0, 200)}`;

async function invite(a) {
  const p = await readProfile(a.handle);
  if (p.missing) return { outcome: "nicht_moeglich", detail: "Profil nicht gefunden" };
  if (p.connected) return { outcome: "schon_vernetzt" };
  if (p.pending) return { outcome: "schon_angefragt" };
  await human();
  const post = note => li(EP.invite, { method: "POST", body: JSON.stringify({ invitee: { inviteeUnion: { memberProfile: `urn:li:fsd_profile:${p.id}` } }, ...(note ? { customMessage: note } : {}) }) });
  const note = a.withNote && a.text ? a.text.slice(0, a.noteMax) : "";
  let r;
  try { r = await post(note); } catch (e) { if (e instanceof LoggedOut) throw e; return { outcome: "unklar", detail: `Anfrage ohne Antwort: ${e.message}` }; }
  if (r.ok) { sentCache.at = 0; return { outcome: "gesendet" }; }
  const why = rejected(r);
  if (/CANT_RESEND|already|bereits/i.test(why)) return { outcome: "schon_angefragt" };
  if (r.status === 429 || /FUSE_LIMIT|WEEKLY|LIMIT_EXCEEDED|limit/i.test(why)) {
    /* with a note the limit may be the monthly note quota of a free account: try once more without */
    if (note && /custom|message|note|premium|quota/i.test(why)) {
      if (a.fallback !== "ohne_notiz") return { outcome: "notizlimit", detail: why };
      await human();
      try { r = await post(""); } catch (e) { if (e instanceof LoggedOut) throw e; return { outcome: "unklar", detail: e.message }; }
      if (r.ok) { sentCache.at = 0; return { outcome: "gesendet_ohne_notiz" }; }
    }
    return { outcome: "wochenlimit", detail: rejected(r) };
  }
  /* LinkedIn turned it down: nothing went out. A server error may have gone through, a check decides */
  return r.status >= 500 ? { outcome: "unklar", detail: why } : { outcome: "fehler", detail: why };
}

async function message(a, my) {
  const p = await readProfile(a.handle);
  if (p.missing || !p.connected) return { outcome: "nicht_vernetzt" };
  await human();
  const t = await readThread(p.id);
  if (!t) return { outcome: "fehler", detail: "Verlauf nicht lesbar, nichts gesendet" };
  const theirs = t.messages.filter(m => m.theirs);
  if (theirs.length) return { outcome: "beantwortet", reply: theirs.map(m => m.text).join("\n").slice(-2000) };
  if (t.messages.some(m => norm(m.text).includes(norm(a.text).slice(0, 60)))) return { outcome: "unklar", detail: "Text steht schon im Verlauf" };
  await human(3000, 7000);
  let r;
  try {
    r = await li(EP.send, { method: "POST", body: JSON.stringify({ message: { body: { attributes: [], text: a.text }, renderContentUnions: [], originToken: randomUUID() },
      mailboxUrn: `urn:li:fsd_profile:${my.id}`, trackingId: String.fromCharCode(...randomBytes(16)), dedupeByClientGeneratedToken: false, hostRecipientUrns: [`urn:li:fsd_profile:${p.id}`] }) });
  } catch (e) { if (e instanceof LoggedOut) throw e; return { outcome: "unklar", detail: `Nachricht ohne Antwort: ${e.message}` }; }
  if (r.ok) return { outcome: "gesendet" };
  return r.status >= 500 ? { outcome: "unklar", detail: rejected(r) } : { outcome: "fehler", detail: rejected(r) };
}

async function check(a) {
  const p = await readProfile(a.handle);
  if (p.missing) return { outcome: "fehler", detail: "Profil nicht gefunden" };
  const r = { outcome: "ok", connected: !!p.connected, pending: !!p.pending, replied: false };
  if (!p.connected) return r;
  await human();
  const t = await readThread(p.id);
  if (!t) return a.settle?.kind === "nachricht" ? { outcome: "fehler", detail: "Verlauf nicht lesbar" } : { ...r, detail: "Verlauf nicht lesbar" };
  const theirs = t.messages.filter(m => m.theirs);
  return { ...r, replied: theirs.length > 0, reply: theirs.length ? theirs.map(m => m.text).join("\n").slice(-2000) : undefined,
    found: a.settle ? t.messages.some(m => norm(m.text).includes(norm(a.settle.text).slice(0, 60))) : undefined };
}

/* ---------- main ---------- */

async function run(once) {
  if (!API || !ENV.LI_TOKEN) throw new Error(`LI_API und LI_TOKEN fehlen in ${ENV_FILE}`);
  await session();
  const my = await me();
  if (!my.id) throw new Error("Eigenes Profil nicht lesbar");
  log(`Worker läuft für ${my.name || my.id} gegen ${API}`);
  for (;;) {
    let c;
    try { c = await portal("claim", { info: `${VERSION} auf ${hostname()}` }); }
    catch (e) { log("Portal nicht erreichbar:", e.message); if (once) break; await sleep(60_000); continue; }
    if (c.wait) { log(`warte ${Math.max(1, Math.round(c.wait / 60))} min: ${c.reason}`); if (once) break; await sleep(Math.min(c.wait, 900) * 1000); continue; }
    const a = c.action;
    log(`${a.kind} ${a.name} (${a.handle})`);
    let r;
    try { r = a.kind === "anfrage" ? await invite(a) : a.kind === "nachricht" ? await message(a, my) : await check(a); }
    catch (e) {
      /* the helpers answer "unklar" themselves once a send went out; anything thrown here happened before that */
      r = e instanceof LoggedOut ? { outcome: "login", detail: e.message } : { outcome: "fehler", detail: String(e.message || e).slice(0, 300) };
    }
    log(" →", r.outcome, r.detail || "");
    for (let i = 0; i < 5; i++) {
      try { await portal("report", { id: a.id, ...r }); break; }
      catch (e) { log("Rückmeldung fehlgeschlagen:", e.message); await sleep(30_000); }
    }
    if (r.outcome === "login") { log("LinkedIn-Sitzung weg: `npm run li:login` mit neuem li_at, danach den Worker neu starten"); break; }
    if (once) break;
  }
}

/* asks for li_at without showing it, checks it against LinkedIn and writes it into the env file */
async function login() {
  console.log("Chrome → linkedin.com (angemeldet) → Entwicklertools (⌥⌘I) → Anwendung → Cookies → https://www.linkedin.com → Wert von li_at kopieren.");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = s => { if (s.includes("li_at")) rl.output.write(s); };
  const liAt = (await new Promise(res => rl.question("li_at: ", res))).trim().replace(/^li_at=/, "").replace(/;$/, "");
  rl.close(); console.log();
  await session(liAt);
  const my = await me();
  if (!my.id) throw new Error("Cookie gilt nicht");
  mkdirSync(HOME, { recursive: true });
  const env = { ...readEnv(), LI_AT: liAt };
  writeFileSync(ENV_FILE, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  chmodSync(ENV_FILE, 0o600);
  log(`Angemeldet als ${my.name || my.id}, gespeichert in ${ENV_FILE}`);
}

async function probe(url) {
  const handle = /linkedin\.com\/in\/([^/?#]+)/i.exec(url)?.[1] || url;
  await session();
  const my = await me();
  const p = await readProfile(decodeURIComponent(handle));
  const t = p.id && p.connected ? await readThread(p.id) : undefined;
  console.log(JSON.stringify({ ich: my, handle, ...p, verlauf: t === undefined ? "nur bei Vernetzten" : t === null ? "nicht lesbar"
    : { nachrichten: t.messages.length, vonIhnen: t.messages.filter(m => m.theirs).length, letzte: t.messages.at(-1)?.text?.slice(0, 80) } }, null, 2));
}

const [cmd, arg] = process.argv.slice(2);
const main = cmd === "login" ? login() : cmd === "probe" && arg ? probe(arg) : cmd === "run" ? run(process.argv.includes("--once"))
  : Promise.reject(new Error("Aufruf: node bridge/linkedin.mjs login | probe <profil-url> | run [--once]"));
main.catch(e => { console.error(e instanceof LoggedOut ? `Bei LinkedIn nicht angemeldet: ${e.message}. npm run li:login` : e.message); process.exit(1); });
