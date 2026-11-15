/* LinkedIn worker for the portal's own campaigns (src/lib/linkedin.ts). Runs on the owner's Mac, from the owner's own IP.
   It drives a real (headless) Chromium via Playwright and calls LinkedIn's internal web API (Voyager, the one linkedin.com itself uses) as
   in-page fetches, so Cloudflare bot management lets it through. It never clicks: it only loads the feed and runs fetches. The owner's li_at is
   taken from a browser on the Mac (Safari, Chrome, or the worker's own Chromium profile) and injected into that profile; the profile then keeps
   the session across restarts. It asks the portal for one action at a time, does it and reports back.
   Rule: once the send request went out, the outcome is "gesendet" (LinkedIn said yes) or "unklar", never "fehler", so nothing is sent twice.

   node bridge/linkedin.mjs login          takes li_at from a browser on the Mac (or asks for it with --paste), checks it and stores it
   node bridge/linkedin.mjs probe <url>    shows what the worker reads for a profile, sends nothing
   node bridge/linkedin.mjs run [--once]   works the queue; when LinkedIn ends the session it takes the current cookie from a browser by itself
   node bridge/linkedin.mjs autostart [off] starts the worker at every login of the Mac (launchd) and keeps it running
   Needs: Playwright with Chromium (npx playwright install chromium).
   Config: ~/.salesmonster/linkedin.env (LI_API, LI_TOKEN, LI_AT, optional LI_UA = user agent, LI_CHROME_PROFILE = a non-default Chrome profile
   folder, LI_CHROME_KEY/LI_CHROMIUM_KEY = cached cookie keys so launchd never asks the Keychain, LI_BROWSER_PROFILE = the worker's Chromium
   profile dir, LI_HEADFUL = show the browser window, LI_CHROME_CHANNEL = "chrome" to drive installed Chrome instead of bundled Chromium) */
import { createDecipheriv, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const HOME = join(homedir(), ".salesmonster");
const ENV_FILE = process.env.LI_ENV || join(HOME, "linkedin.env");
const readEnv = () => existsSync(ENV_FILE) ? Object.fromEntries(readFileSync(ENV_FILE, "utf8").split("\n")
  .map(l => /^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/.exec(l)).filter(Boolean).map(m => [m[1], m[2]])) : {};
const ENV = { ...readEnv(), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("LI_"))) };
const API = (ENV.LI_API || "").replace(/\/$/, "");
const UA = ENV.LI_UA || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const VERSION = "linkedin-worker 2 (api)";
const DEBUG = !!ENV.LI_DEBUG;
const saveEnv = patch => { mkdirSync(HOME, { recursive: true }); Object.assign(ENV, patch); const env = { ...readEnv(), ...patch };
  writeFileSync(ENV_FILE, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n"); chmodSync(ENV_FILE, 0o600); };

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

/* ---------- the cookie from the browsers on this Mac ---------- */

/* Browsers keep the LinkedIn login across reboots, so the worker reads li_at from their cookie stores instead of asking for it.
   Chromium family (Chrome, plus the worker's own Chromium profile): copy of the SQLite file, value AES-128-CBC with the key derived
   from the browser's Keychain entry (asked once, then cached in the env file). Safari: Cookies.binarycookies, unencrypted. */
const CHROMIUM_STORES = [
  { name: "Chrome", dir: ENV.LI_CHROME_PROFILE || join(homedir(), "Library/Application Support/Google/Chrome/Default"), service: "Chrome Safe Storage", keyVar: "LI_CHROME_KEY" },
  { name: "Worker-Chromium", dir: join(HOME, "linkedin-profile/Default"), service: "Chromium Safe Storage", keyVar: "LI_CHROMIUM_KEY" },
];
function chromiumKey(st) {
  if (ENV[st.keyVar]) return Buffer.from(ENV[st.keyVar], "hex");
  const pw = execFileSync("security", ["find-generic-password", "-wa", st.service], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const key = pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
  saveEnv({ [st.keyVar]: key.toString("hex") });
  return key;
}
const printable = b => /^[\x20-\x7e]+$/.test(b.toString("latin1"));
function chromiumLiAt(st) {
  const db = join(st.dir, "Cookies");
  if (!existsSync(db)) return null;
  const tmp = mkdtempSync(join(tmpdir(), "li-cookies-"));
  try {
    copyFileSync(db, join(tmp, "Cookies"));
    const hex = execFileSync("sqlite3", [join(tmp, "Cookies"), "select hex(encrypted_value) from cookies where name='li_at' and host_key like '%linkedin.com' order by expires_utc desc limit 1"], { encoding: "utf8" }).trim();
    if (!hex) return null;
    const enc = Buffer.from(hex, "hex");
    if (enc.subarray(0, 3).toString() !== "v10") return null;
    const d = createDecipheriv("aes-128-cbc", chromiumKey(st), Buffer.alloc(16, " "));
    let plain = Buffer.concat([d.update(enc.subarray(3)), d.final()]);
    if (!printable(plain) && plain.length > 32) plain = plain.subarray(32); /* Chrome ≥ 130 puts a hash of the host in front */
    return printable(plain) ? plain.toString() : null;
  } catch (e) { if (DEBUG) console.error(`[li] ${st.name}: Cookie nicht lesbar:`, e.message); return null; }
  finally { rmSync(tmp, { recursive: true, force: true }); }
}
function safariLiAt() {
  const f = join(homedir(), "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies");
  try {
    if (!existsSync(f)) return null;
    const b = readFileSync(f);
    if (b.toString("latin1", 0, 4) !== "cook") return null;
    const pages = b.readUInt32BE(4); let off = 8 + 4 * pages; let best = null;
    for (let p = 0; p < pages; p++) {
      const size = b.readUInt32BE(8 + 4 * p), page = b.subarray(off, off + size); off += size;
      const count = page.readUInt32LE(4);
      for (let i = 0; i < count; i++) {
        const co = page.readUInt32LE(8 + 4 * i), c = page.subarray(co, co + page.readUInt32LE(co));
        const str = o => { const e = c.indexOf(0, o); return c.toString("utf8", o, e < 0 ? c.length : e); };
        const url = str(c.readUInt32LE(16)), name = str(c.readUInt32LE(20)), value = str(c.readUInt32LE(28)), expiry = c.readDoubleLE(40);
        if (name === "li_at" && /linkedin\.com$/.test(url) && (!best || expiry > best.expiry)) best = { value, expiry };
      }
    }
    return best?.value || null;
  } catch (e) { if (DEBUG) console.error("[li] Safari: Cookies nicht lesbar:", e.message); return null; }
}
/* every li_at found on this Mac, Chromium stores first then Safari; duplicates and the one that just failed are left out */
function browserCookies(skip) {
  const out = [];
  for (const st of CHROMIUM_STORES) { const v = chromiumLiAt(st); if (v && v !== skip && !out.some(o => o.value === v)) out.push({ source: st.name, value: v }); }
  const sa = safariLiAt(); if (sa && sa !== skip && !out.some(o => o.value === sa)) out.push({ source: "Safari", value: sa });
  return out;
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
let liAtRevoked = false;
const REVOKED = "LinkedIn hat dieses li_at für ungültig erklärt (im Browser abgemeldet oder Sitzung erneuert). Aktuelles li_at aus einem Browser holen";

/* opens the feed in the persistent profile and gets the session going; the profile may already be logged in from a previous run, so this is
   tried first before any cookie is injected. A fixed liAt is injected and then checked. Order otherwise: stored cookie, then the Mac's browsers. */
async function session(liAt) {
  await browser();
  if (liAt) return connect(liAt);
  if (await openFeed()) { log("LinkedIn-Browser-Profil noch angemeldet"); return; }
  const seen = new Set();
  const cands = [];
  if (ENV.LI_AT) cands.push({ value: ENV.LI_AT, source: "gespeichert" });
  for (const c of browserCookies()) cands.push(c);
  let err;
  for (const c of cands) {
    if (!c.value || seen.has(c.value)) continue;
    seen.add(c.value);
    try { await connect(c.value); } catch (e) { if (!(e instanceof LoggedOut)) throw e; err = e; if (DEBUG) console.error(`[li] ${c.source}: ${e.message}`); continue; }
    if (c.value !== ENV.LI_AT) saveEnv({ LI_AT: c.value });
    log(`li_at aus ${c.source} übernommen`);
    return;
  }
  throw new LoggedOut((err?.message || "kein li_at gefunden") + ". In einem Browser (Chrome oder Safari) bei linkedin.com anmelden, der Worker holt das Cookie dann selbst");
}
/* Transport: a real (headless) Chromium. LinkedIn sits behind Cloudflare bot management (__cf_bm), which refuses bare node fetch but accepts a
   genuine browser. We inject the owner's li_at into a persistent Chromium profile, load the feed so Cloudflare clears the browser, and run every
   Voyager call as an in-page fetch — exactly what linkedin.com's own web app does. The profile persists __cf_bm and the device fingerprint across
   runs, so the worker keeps looking like the same browser. No clicking, only page loads and fetches. */
const PROFILE_DIR = ENV.LI_BROWSER_PROFILE || join(HOME, "linkedin-profile");
let _ctx = null, _page = null, _csrf = "";
let HEADFUL = !!ENV.LI_HEADFUL; /* login turns this on so the owner can sign in in a visible window */

async function browser() {
  if (_page && !_page.isClosed?.()) return _page;
  const { chromium } = await import("playwright");
  _ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !HEADFUL,
    channel: ENV.LI_CHROME_CHANNEL || undefined, /* e.g. "chrome" to drive installed Chrome instead of bundled Chromium */
    userAgent: UA,
    locale: "de-DE",
    timezoneId: ENV.LI_TZ || "Europe/Berlin",
    viewport: { width: 1280, height: 860 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  _ctx.setDefaultTimeout(Number(ENV.LI_TIMEOUT || 30000));
  _page = _ctx.pages()[0] || await _ctx.newPage();
  await _page.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch {} });
  return _page;
}
async function closeBrowser() { try { await _ctx?.close(); } catch {} _ctx = _page = null; }

async function csrfToken() {
  const cs = await _ctx.cookies("https://www.linkedin.com");
  return (cs.find(c => c.name === "JSESSIONID")?.value || "").replace(/"/g, "");
}

/* loads the feed; true = logged in (csrf ready), false = redirected to login/authwall/checkpoint. Injects no cookie, so it can test the
   profile's existing session. */
async function openFeed() {
  const page = await browser();
  liAtRevoked = false;
  let resp;
  try { resp = await page.goto(`${LI}/feed/`, { waitUntil: "domcontentloaded" }); }
  catch (e) { throw new Error(`Feed-Seite nicht geladen: ${e.message}`); }
  const url = page.url();
  if (DEBUG) console.error(`[li] feed ${resp?.status()} → ${url}`);
  if (/\/(login|authwall|checkpoint|uas\/|signup)/.test(url)) return false;
  _csrf = await csrfToken();
  return true;
}
async function inject(liAt) {
  await _ctx.addCookies([
    { name: "li_at", value: liAt, domain: ".www.linkedin.com", path: "/", secure: true, httpOnly: true, sameSite: "None" },
    { name: "li_at", value: liAt, domain: ".linkedin.com", path: "/", secure: true, httpOnly: true, sameSite: "None" },
  ]);
}
/* inject a specific li_at and confirm it; a redirect to login means the cookie is dead */
async function connect(liAt) {
  await browser();
  await inject(liAt);
  if (!await openFeed()) { liAtRevoked = true; throw new LoggedOut(REVOKED); }
}

/* one call; status and parsed body, never throws on HTTP errors (the caller decides), throws LoggedOut when the session is gone.
   The fetch runs inside the LinkedIn page, so it carries the browser's cookies, Cloudflare clearance and real TLS fingerprint. */
async function li(path, init = {}) {
  const page = await browser();
  if (!_csrf) _csrf = await csrfToken();
  let res;
  try {
    res = await page.evaluate(async ({ path, init, csrf }) => {
      const r = await fetch(path, {
        method: init.method || "GET",
        credentials: "include",
        redirect: "manual",
        headers: {
          accept: "application/vnd.linkedin.normalized+json+2.1",
          "x-restli-protocol-version": "2.0.0",
          "x-li-lang": "de_DE",
          "csrf-token": csrf,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers || {}),
        },
        body: init.body,
      });
      const text = await r.text();
      return { status: r.status, type: r.type, url: r.url, text };
    }, { path, init, csrf: _csrf });
  } catch (e) {
    /* the page or context died (crash, navigation, closed): drop it so the next attempt reconnects */
    if (/closed|crash|detached|Target|context/i.test(e.message)) { await closeBrowser(); throw new LoggedOut(`Browser verloren: ${e.message}`); }
    throw e;
  }
  if (DEBUG) console.error(`[li] ${res.status} ${res.type} ${path}`);
  /* fetch redirect:manual reports an opaqueredirect (status 0) for a cross-/same redirect, or 401/999 on a dead session */
  if (/\/(login|authwall|checkpoint)/.test(res.url)) throw new LoggedOut("li_at abgelaufen");
  if (res.status === 401 || res.status === 999 || res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    if (liAtRevoked) throw new LoggedOut(REVOKED);
    throw new LoggedOut(res.status === 999 ? "LinkedIn blockt die Anfragen (999)" : `abgemeldet (${res.status || "redirect"})`);
  }
  let json = null; try { json = JSON.parse(res.text); } catch {}
  return { status: res.status, ok: res.status >= 200 && res.status < 300, json, text: res.text };
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

/* the connection degree out of a profile response. A 1st-degree contact carries no DISTANCE token; instead the WebTopCard holds
   "memberRelationshipUnion":{"*connection":"urn:li:fsd_connection:…"} (an outgoing invite shows "*invitation", a stranger "*noConnection").
   networkinfo gave an explicit DISTANCE_x while it existed (410 since 2026). */
const isConnected = text => /"memberRelationship(?:Union|Data)"\s*:\s*\{\s*"\*connection"/.test(text);
const hasInvite = text => /"memberRelationship(?:Union|Data)"\s*:\s*\{\s*"\*invitation"/.test(text);
const degreeOf = text => isConnected(text) ? "DISTANCE_1"
  : /"DISTANCE_[0-9A-Z_]+"/.exec(text)?.[0]?.replace(/"/g, "") || "";

/* member id, whether connected (1st degree) and whether an invite of ours is open */
async function readProfile(handle) {
  const p = await li(EP.profile(handle));
  if (p.status === 404) return { missing: true };
  if (!p.ok) throw new Error(`Profil ${p.status}`);
  const first = p.json?.data?.["*elements"]?.[0] || p.json?.elements?.[0]?.entityUrn || "";
  const id = IDS.exec(first)?.[1] || IDS.exec(p.text)?.[1];
  if (!id) return { missing: true };
  /* the degree sits in the profile response; networkinfo is a deprecated fallback and is only tried if the profile gave nothing */
  let distance = degreeOf(p.text);
  if (!distance) {
    await human(600, 1500);
    const n = await li(EP.networkInfo(handle)).catch(e => { if (e instanceof LoggedOut) throw e; return { ok: false, text: "" }; });
    if (n.ok) distance = n.json?.distance?.value || n.json?.data?.distance?.value || degreeOf(n.text);
  }
  const connected = distance === "DISTANCE_1" || isConnected(p.text);
  /* the profile itself shows an open invite from us; fall back to the sent-invites list when it does not */
  const pending = connected ? false : hasInvite(p.text) || await pendingList(id, handle);
  return { id, distance, connected, pending };
}

/* our open invites, read once per run of checks (a few pages at most) */
let sentCache = { at: 0, text: "" };
async function pendingList(id, handle) {
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

/* waits until the session works again: Chrome's cookie is tried every few minutes (the owner only has to be logged in there) */
async function waitForLogin(once) {
  for (;;) {
    try { await session(); return await me(); }
    catch (e) {
      if (!(e instanceof LoggedOut)) throw e;
      log(`LinkedIn: ${e.message}`);
      if (once) throw e;
      await sleep(5 * 60_000);
    }
  }
}
const act = (a, my) => a.kind === "anfrage" ? invite(a) : a.kind === "nachricht" ? message(a, my) : check(a);

async function run(once) {
  if (!API || !ENV.LI_TOKEN) throw new Error(`LI_API und LI_TOKEN fehlen in ${ENV_FILE}`);
  let my = await waitForLogin(once);
  if (!my.id) throw new Error("Eigenes Profil nicht lesbar");
  log(`Worker läuft für ${my.name || my.id} gegen ${API}`);
  let loggedIn = true;
  for (;;) {
    let c;
    try { c = await portal("claim", { info: `${VERSION} auf ${hostname()}`, loggedIn }); loggedIn = false; }
    catch (e) { log("Portal nicht erreichbar:", e.message); if (once) break; await sleep(60_000); continue; }
    if (c.wait) { log(`warte ${Math.max(1, Math.round(c.wait / 60))} min: ${c.reason}`); if (once) break; await sleep(Math.min(c.wait, 900) * 1000); continue; }
    const a = c.action;
    log(`${a.kind} ${a.name} (${a.handle})`);
    let r;
    try { r = await act(a, my); }
    catch (e) {
      /* the helpers answer "unklar" themselves once a send went out; anything thrown here happened before that, so a retry is safe */
      if (e instanceof LoggedOut) {
        try { await session(); my = await me(); r = await act(a, my); }
        catch (e2) { r = { outcome: "login", detail: (e2 instanceof LoggedOut ? e2 : e).message }; }
      } else r = { outcome: "fehler", detail: String(e.message || e).slice(0, 300) };
    }
    log(" →", r.outcome, r.detail || "");
    for (let i = 0; i < 5; i++) {
      try { await portal("report", { id: a.id, ...r }); break; }
      catch (e) { log("Rückmeldung fehlgeschlagen:", e.message); await sleep(30_000); }
    }
    if (r.outcome === "login") { if (once) break; my = await waitForLogin(false); loggedIn = true; continue; }
    if (once) break;
  }
}

/* waits in a visible browser window until the owner has signed in to LinkedIn; the session then lives in the worker's own Chromium profile */
async function loginInWindow() {
  HEADFUL = true;
  if (_ctx) await closeBrowser(); /* a headless context may already be open from the silent check: reopen it visibly */
  console.log("Öffne ein Browserfenster … (kann ein paar Sekunden dauern)");
  const page = await browser();
  console.log("Melde dich im Fenster bei LinkedIn an (ggf. Code/2FA). Sobald dein Feed erscheint, geht es von selbst weiter.");
  try { await page.bringToFront(); } catch {}
  try { await page.goto(`${LI}/login`, { waitUntil: "domcontentloaded" }); } catch {}
  const deadline = Date.now() + 10 * 60_000; /* 10 minutes to finish signing in */
  let announced = false;
  for (;;) {
    await sleep(2500);
    const cs = await _ctx.cookies("https://www.linkedin.com").catch(() => []);
    const liAt = cs.find(c => c.name === "li_at")?.value;
    const url = page.url();
    if (liAt && liAt.length > 20 && !/\/(login|checkpoint|uas\/|signup|authwall)/.test(url)) {
      if (!announced) { console.log("Anmeldung erkannt, prüfe die Sitzung …"); announced = true; }
      /* confirm the session really works before we stop; right after login the first API call can need a few tries */
      _csrf = (cs.find(c => c.name === "JSESSIONID")?.value || "").replace(/"/g, "");
      try { const my = await me(); if (my.id) return; } catch (e) { if (DEBUG) console.error(`[li] Bestätigung noch nicht bereit: ${e.message}`); }
    }
    if (Date.now() > deadline) throw new LoggedOut("Zeit abgelaufen, keine Anmeldung im Fenster erkannt");
  }
}

/* the first API call right after login can be slow or briefly redirect; retry a few times before giving up */
async function meConfirm(tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { const my = await me(); if (my.id) return my; last = new Error("ohne Mitglieds-ID"); }
    catch (e) { last = e; if (DEBUG) console.error(`[li] me-Versuch ${i + 1}: ${e.message}`); }
    await sleep(2000);
  }
  throw last || new Error("Anmeldung nicht bestätigt");
}

/* makes the worker logged in. Order: a session that already works (profile, stored cookie, the Mac's browsers); else open a window to sign in;
   with --paste, take the li_at cookie by hand instead of opening a window. */
async function login(paste) {
  if (paste) {
    console.log("Browser → linkedin.com (angemeldet) → Entwicklertools (⌥⌘I) → Anwendung → Cookies → https://www.linkedin.com → Wert von li_at kopieren.");
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes("li_at")) rl.output.write(s); };
    const liAt = (await new Promise(res => rl.question("li_at: ", res))).trim().replace(/^li_at=/, "").replace(/;$/, "");
    rl.close(); console.log();
    await session(liAt);
    saveEnv({ LI_AT: liAt });
  } else {
    console.log("Prüfe bestehende LinkedIn-Anmeldung …");
    let ok = false;
    try { await session(); const m = await me(); ok = !!m.id; }
    catch (e) { if (!(e instanceof LoggedOut)) throw e; log(e.message); }
    if (!ok) await loginInWindow();
  }
  const my = await meConfirm();
  log(`Angemeldet als ${my.name || my.id}. Die Sitzung liegt im Browser-Profil ${PROFILE_DIR} und bleibt nach Neustarts erhalten.`);
}

/* launchd agent: starts the worker when the owner logs in to the Mac and restarts it when it stops; log in ~/.salesmonster */
const PLIST = join(homedir(), "Library/LaunchAgents/de.salesmonster.linkedin-worker.plist");
function autostart(off) {
  const label = "de.salesmonster.linkedin-worker";
  if (off) {
    try { execFileSync("launchctl", ["bootout", `gui/${process.getuid()}/${label}`], { stdio: "ignore" }); } catch {}
    rmSync(PLIST, { force: true });
    return log("Autostart entfernt");
  }
  const script = fileURLToPath(import.meta.url), logFile = join(HOME, "linkedin-worker.log");
  const esc = v => v.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  mkdirSync(HOME, { recursive: true }); mkdirSync(dirname(PLIST), { recursive: true });
  writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${esc(process.execPath)}</string><string>${esc(script)}</string><string>run</string></array>
  <key>WorkingDirectory</key><string>${esc(dirname(dirname(script)))}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${esc(logFile)}</string>
  <key>StandardErrorPath</key><string>${esc(logFile)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
</dict></plist>
`);
  try { execFileSync("launchctl", ["bootout", `gui/${process.getuid()}/${label}`], { stdio: "ignore" }); } catch {}
  execFileSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, PLIST], { stdio: "inherit" });
  log(`Autostart eingerichtet: ${PLIST}, Log in ${logFile}`);
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

/* sends one connection request by hand (for a test or a one-off), with the same checks the worker uses. --note "…" adds a note, else none. */
async function inviteOnce(url, note) {
  const handle = /linkedin\.com\/in\/([^/?#]+)/i.exec(url)?.[1] || url;
  await session();
  const my = await me();
  if (!my.id) throw new Error("Eigenes Profil nicht lesbar");
  const r = await invite({ handle: decodeURIComponent(handle), withNote: !!note, text: note || "", noteMax: 300, fallback: "nein" });
  console.log(JSON.stringify({ handle, ...r }, null, 2));
}

const [cmd, arg] = process.argv.slice(2);
const noteArg = (() => { const i = process.argv.indexOf("--note"); return i > -1 ? process.argv[i + 1] : ""; })();
const main = cmd === "login" ? login(process.argv.includes("--paste")) : cmd === "probe" && arg ? probe(arg) : cmd === "run" ? run(process.argv.includes("--once"))
  : cmd === "invite" && arg ? inviteOnce(arg, noteArg) : cmd === "autostart" ? Promise.resolve().then(() => autostart(arg === "off"))
  : Promise.reject(new Error("Aufruf: node bridge/linkedin.mjs login [--paste] | probe <profil-url> | invite <profil-url> [--note \"…\"] | run [--once] | autostart [off]"));
main.then(async () => { if (cmd !== "run") await closeBrowser(); })
  .catch(async e => { await closeBrowser(); console.error(e instanceof LoggedOut ? `Bei LinkedIn nicht angemeldet: ${e.message}. npm run li:login` : e.message); process.exit(1); });
