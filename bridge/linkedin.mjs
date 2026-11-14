/* LinkedIn worker for the portal's own campaigns (src/lib/linkedin.ts). Runs on the owner's Mac in a Chrome profile of its own,
   signed in to the owner's LinkedIn account. It asks the portal for one action at a time, does it like a person would and reports back.
   Rule: once the final send click happened, the outcome is "gesendet" (seen on LinkedIn) or "unklar", never "fehler", so nothing is sent twice.

   node bridge/linkedin.mjs login          sign in once (window opens, close it when the feed shows)
   node bridge/linkedin.mjs probe <url>    shows what the worker reads on a profile, clicks nothing
   node bridge/linkedin.mjs run [--once]   works the queue
   Config: ~/.salesmonster/linkedin.env (LI_API, LI_TOKEN, optional LI_PROFILE, LI_CHANNEL, LI_HEADLESS) */
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

const HOME = join(homedir(), ".salesmonster");
const ENV_FILE = process.env.LI_ENV || join(HOME, "linkedin.env");
if (existsSync(ENV_FILE)) for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const API = (process.env.LI_API || "").replace(/\/$/, "");
const TOKEN = process.env.LI_TOKEN || "";
const PROFILE = process.env.LI_PROFILE || join(HOME, "linkedin-profile");
const CHANNEL = process.env.LI_CHANNEL || "chrome";
const HEADLESS = process.env.LI_HEADLESS === "1";
const VERSION = "linkedin-worker 1";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const human = (min = 800, max = 2200) => sleep(min + Math.random() * (max - min));
const log = (...a) => console.log(new Date().toLocaleString("de-DE"), ...a);
const norm = s => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

/* ---------- portal ---------- */

async function api(path, body) {
  const r = await fetch(`${API}/api/linkedin/worker/${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Portal ${r.status}: ${j.error || "ohne Text"}`);
  return j;
}

/* ---------- browser ---------- */

async function browser() {
  mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, { channel: CHANNEL, headless: HEADLESS, viewport: { width: 1280, height: 860 }, locale: "de-DE",
    args: ["--disable-blink-features=AutomationControlled"] });
  const page = ctx.pages()[0] || await ctx.newPage();
  return { ctx, page };
}

const loggedOut = page => /\/(login|authwall|checkpoint|uas\/login)/.test(page.url());

async function openProfile(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.locator("main h1").first().waitFor({ timeout: 20_000 }).catch(() => {});
  await human(1500, 3500);
  await page.mouse.wheel(0, 200 + Math.random() * 300);
  await human(600, 1400);
}

/* the profile's top card: the first card in main that holds the name */
const topCard = page => page.locator("main section").filter({ has: page.locator("h1") }).first();

const CONNECT = /^(Vernetzen|Connect)$/i, PENDING = /^(Ausstehend|Pending)$/i, MESSAGE = /^(Nachricht|Message)$/i, MORE = /^(Mehr|More|Weitere Aktionen|More actions)$/i;

async function readProfile(page) {
  if (loggedOut(page)) return { login: true };
  const card = topCard(page);
  if (!(await card.count())) return { missing: true };
  const text = await card.innerText().catch(() => "");
  const labels = await card.locator("button, a[role=button], a").evaluateAll(els => els.map(e => ({ text: (e.innerText || "").trim(), aria: e.getAttribute("aria-label") || "" })));
  const has = re => labels.some(l => re.test(l.text) || re.test(l.aria));
  const degree1 = /(·\s*1\.|\b1st\b|1\.\s*Grad|Kontakt 1\.)/i.test(text);
  return {
    name: (await page.locator("main h1").first().innerText().catch(() => "")).trim(),
    connected: degree1,
    pending: has(PENDING) || labels.some(l => /(Ausstehend|Pending|zurückziehen|withdraw)/i.test(l.aria)),
    connect: has(CONNECT) || labels.some(l => /(einladen, sich .* zu vernetzen|Invite .* to connect)/i.test(l.aria)),
    message: has(MESSAGE),
  };
}

async function clickConnect(page) {
  const card = topCard(page);
  const direct = card.locator("button").filter({ hasText: CONNECT }).first();
  if (await direct.isVisible().catch(() => false)) { await direct.click(); return true; }
  const aria = card.locator("button[aria-label*='vernetzen' i], button[aria-label*='to connect' i]").first();
  if (await aria.isVisible().catch(() => false)) { await aria.click(); return true; }
  const more = card.locator("button").filter({ hasText: MORE }).first();
  if (!(await more.isVisible().catch(() => false))) return false;
  await more.click();
  await human(500, 1200);
  const item = page.locator(".artdeco-dropdown__content [role=button], [role=menu] [role=menuitem], [role=menu] [role=button]").filter({ hasText: CONNECT }).first();
  if (!(await item.isVisible().catch(() => false))) { await page.keyboard.press("Escape"); return false; }
  await item.click();
  return true;
}

const dialog = page => page.locator("[role=dialog]").last();
const dialogButton = (page, re) => dialog(page).locator("button").filter({ hasText: re }).first();
async function closeDialog(page) {
  const x = dialog(page).locator("button[aria-label*='schließen' i], button[aria-label*='Dismiss' i], button[aria-label*='close' i]").first();
  if (await x.isVisible().catch(() => false)) await x.click(); else await page.keyboard.press("Escape");
  await human(400, 900);
}

async function typeHuman(page, locator, text) {
  await locator.click();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    await page.keyboard.type(lines[i], { delay: 25 + Math.random() * 55 });
    if (i < lines.length - 1) await page.keyboard.press("Shift+Enter");
  }
}

/* ---------- messaging ---------- */

async function closeChats(page) {
  for (const b of await page.locator("button[aria-label*='Unterhaltung schließen' i], button[aria-label*='Close your conversation' i], button[aria-label*='Close your draft' i]").all())
    await b.click().catch(() => {});
}

/* opens the thread with the person from their profile; returns the box to type into, or null */
async function openThread(page) {
  await closeChats(page);
  const btn = topCard(page).locator("button, a").filter({ hasText: MESSAGE }).first();
  if (!(await btn.isVisible().catch(() => false))) return null;
  await btn.click();
  const box = page.locator(".msg-form__contenteditable[contenteditable=true], div[role=textbox][contenteditable=true]").last();
  try { await box.waitFor({ timeout: 12_000 }); } catch { return null; }
  await human(1500, 2500);
  return box;
}

/* what the thread shows: messages grouped by sender; a group whose sender is the person counts as their reply */
async function readThread(page, a) {
  const list = page.locator(".msg-s-message-list, .msg-s-message-list-content").last();
  const groups = await list.locator(".msg-s-message-list__event").evaluateAll((els, handle) => {
    let who = "";
    return els.map(e => {
      const name = e.querySelector(".msg-s-message-group__name, .msg-s-message-group__profile-link")?.textContent?.trim();
      const link = e.querySelector("a[href*='/in/']")?.getAttribute("href") || "";
      if (name) who = name;
      return { who, theirs: link.toLowerCase().includes(`/in/${handle}`), body: [...e.querySelectorAll(".msg-s-event-listitem__body")].map(b => b.textContent.trim()).join("\n") };
    });
  }, a.handle).catch(() => null);
  if (!groups) return null;
  const theirs = groups.filter(g => g.theirs || norm(g.who) === norm(a.name));
  return { text: norm(groups.map(g => g.body).join("\n")), replied: theirs.length > 0, reply: theirs.map(g => g.body).filter(Boolean).join("\n").slice(-2000) };
}

/* ---------- actions ---------- */

async function invite(page, a) {
  await openProfile(page, a.profile);
  const p = await readProfile(page);
  if (p.login) return { outcome: "login" };
  if (p.missing) return { outcome: "nicht_moeglich", detail: "Profil nicht gefunden" };
  if (p.connected) return { outcome: "schon_vernetzt" };
  if (p.pending) return { outcome: "schon_angefragt" };
  if (!(await clickConnect(page))) return { outcome: "nicht_moeglich", detail: "kein Vernetzen-Knopf (nur Folgen oder eingeschränkt)" };
  await human(1200, 2200);

  const dtext = await dialog(page).innerText().catch(() => "");
  if (/(wöchentliche|weekly).{0,40}(limit|Grenze)/i.test(dtext)) { await closeDialog(page); return { outcome: "wochenlimit" }; }
  if (await dialog(page).locator("input[type=email]").count()) { await closeDialog(page); return { outcome: "nicht_moeglich", detail: "LinkedIn verlangt die E-Mail-Adresse der Person" }; }

  let withNote = a.withNote && !!a.text;
  if (withNote) {
    const add = dialogButton(page, /(Notiz hinzufügen|Add a note)/i);
    if (await add.isVisible().catch(() => false)) { await add.click(); await human(800, 1500); }
    const area = dialog(page).locator("textarea").first();
    if (!(await area.isVisible().catch(() => false))) {
      /* free account: notes used up for this month, LinkedIn shows Premium instead of the text field */
      await closeDialog(page);
      if (a.fallback !== "ohne_notiz") return { outcome: "notizlimit" };
      await openProfile(page, a.profile);
      if (!(await clickConnect(page))) return { outcome: "fehler", detail: "Vernetzen nach Notizlimit nicht erneut geöffnet" };
      await human(1200, 2000);
      withNote = false;
    } else {
      await typeHuman(page, area, a.text.slice(0, a.noteMax));
      await human(800, 1600);
    }
  }
  const send = withNote ? dialogButton(page, /^(Senden|Send|Einladung senden|Send invitation)$/i)
    : dialogButton(page, /(Ohne Notiz senden|Send without a note|^Senden$|^Send$)/i);
  if (!(await send.isVisible().catch(() => false)) || !(await send.isEnabled().catch(() => false))) { await closeDialog(page); return { outcome: "fehler", detail: "Senden-Knopf nicht gefunden" }; }

  await send.click();
  /* from here on: sent or unclear */
  await human(2500, 4000);
  const after = await dialog(page).innerText().catch(() => "");
  if (/(wöchentliche|weekly).{0,40}(limit|Grenze)/i.test(after)) { await closeDialog(page); return { outcome: "unklar", detail: "Wochenlimit nach dem Klick gemeldet" }; }
  await openProfile(page, a.profile);
  const q = await readProfile(page);
  if (q.pending || q.connected) return { outcome: withNote || !a.withNote ? "gesendet" : "gesendet_ohne_notiz" };
  return { outcome: "unklar", detail: "nach dem Senden keine offene Anfrage zu sehen" };
}

async function message(page, a) {
  await openProfile(page, a.profile);
  const p = await readProfile(page);
  if (p.login) return { outcome: "login" };
  if (!p.connected) return { outcome: "nicht_vernetzt" };
  const box = await openThread(page);
  if (!box) return { outcome: "fehler", detail: "Nachrichtenfenster nicht geöffnet" };
  const t = await readThread(page, a);
  if (!t) { await closeChats(page); return { outcome: "fehler", detail: "Verlauf nicht lesbar, nichts gesendet" }; }
  if (t.replied) { await closeChats(page); return { outcome: "beantwortet", reply: t.reply }; }
  /* the same text already in the thread: it went out before, do not send again */
  if (t.text.includes(norm(a.text).slice(0, 60))) { await closeChats(page); return { outcome: "unklar", detail: "Text steht schon im Verlauf" }; }

  await typeHuman(page, box, a.text);
  await human(1000, 2000);
  const send = page.locator(".msg-form__send-button, form button[type=submit]").filter({ hasText: /^(Senden|Send)$/i }).last();
  if (!(await send.isEnabled().catch(() => false))) {
    await box.click(); await page.keyboard.press("Meta+A"); await page.keyboard.press("Backspace");
    await closeChats(page);
    return { outcome: "fehler", detail: "Senden-Knopf nicht aktiv" };
  }
  await send.click();
  /* from here on: sent or unclear */
  await human(2500, 4000);
  const u = await readThread(page, a);
  await closeChats(page);
  return u && u.text.includes(norm(a.text).slice(0, 60)) ? { outcome: "gesendet" } : { outcome: "unklar", detail: "Nachricht nach dem Senden nicht im Verlauf" };
}

async function check(page, a) {
  await openProfile(page, a.profile);
  const p = await readProfile(page);
  if (p.login) return { outcome: "login" };
  if (p.missing) return { outcome: "fehler", detail: "Profil nicht gefunden" };
  const r = { outcome: "ok", connected: !!p.connected, pending: !!p.pending, replied: false };
  if (!p.connected) return r;
  const box = await openThread(page);
  const t = box ? await readThread(page, a) : null;
  await closeChats(page);
  if (!t) return a.settle?.kind === "nachricht" ? { outcome: "fehler", detail: "Verlauf nicht lesbar" } : { ...r, detail: "Verlauf nicht lesbar" };
  return { ...r, replied: t.replied, reply: t.replied ? t.reply : undefined, found: a.settle ? t.text.includes(norm(a.settle.text).slice(0, 60)) : undefined };
}

/* ---------- main ---------- */

async function run(once) {
  if (!API || !TOKEN) throw new Error(`LI_API und LI_TOKEN fehlen in ${ENV_FILE}`);
  const { ctx, page } = await browser();
  const stop = async () => { await ctx.close().catch(() => {}); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  log(`Worker läuft gegen ${API}`);
  for (;;) {
    let c;
    try { c = await api("claim", { info: `${VERSION} auf ${hostname()}` }); }
    catch (e) { log("Portal nicht erreichbar:", e.message); await sleep(60_000); continue; }
    if (c.wait) { log(`warte ${Math.round(c.wait / 60)} min: ${c.reason}`); if (once) break; await sleep(Math.min(c.wait, 900) * 1000); continue; }
    const a = c.action;
    log(`${a.kind} ${a.name} (${a.handle})`);
    let r;
    try { r = a.kind === "anfrage" ? await invite(page, a) : a.kind === "nachricht" ? await message(page, a) : await check(page, a); }
    /* an error before the send click is surely not sent; after it the helpers already answered "unklar" */
    catch (e) { r = { outcome: a.kind === "pruefen" ? "fehler" : "unklar", detail: String(e.message || e).slice(0, 300) }; }
    log(" →", r.outcome, r.detail || "");
    for (let i = 0; i < 5; i++) {
      try { await api("report", { id: a.id, ...r }); break; }
      catch (e) { log("Rückmeldung fehlgeschlagen:", e.message); await sleep(30_000); }
    }
    if (r.outcome === "login") { log("Bei LinkedIn abgemeldet: `npm run li:login`, danach den Worker neu starten"); break; }
    if (once) break;
  }
  await ctx.close();
}

async function login() {
  const { ctx, page } = await browser();
  await page.goto("https://www.linkedin.com/login");
  log("Im Fenster bei LinkedIn anmelden. Sobald der Feed erscheint, schließt sich das Fenster.");
  await page.waitForURL(/linkedin\.com\/feed/, { timeout: 10 * 60_000 });
  await human(2000, 3000);
  await ctx.close();
  log(`Angemeldet, Profil gespeichert in ${PROFILE}`);
}

async function probe(url) {
  const { ctx, page } = await browser();
  await openProfile(page, url);
  console.log(JSON.stringify(await readProfile(page), null, 2));
  await ctx.close();
}

const [cmd, arg] = process.argv.slice(2);
const main = cmd === "login" ? login() : cmd === "probe" && arg ? probe(arg) : cmd === "run" ? run(process.argv.includes("--once"))
  : Promise.reject(new Error("Aufruf: node bridge/linkedin.mjs login | probe <profil-url> | run [--once]"));
main.catch(e => { console.error(e.message); process.exit(1); });
