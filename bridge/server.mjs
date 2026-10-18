/* Runs the unmodified Claude Code CLI for the portal, signed in with the owner's own subscription (claude auth login).
   Only web search and web fetch are available to Claude here: no shell, no files, no MCP, no CLAUDE.md. */
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT) || 8787;
const SECRET = process.env.BRIDGE_SECRET || "";
const CLAUDE = process.env.CLAUDE_BIN || "claude";
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const MAX = Number(process.env.BRIDGE_CONCURRENCY) || 2;
const TIMEOUT = 280_000;
const CWD = join(tmpdir(), "salesmonster-bridge");
mkdirSync(CWD, { recursive: true });
if (SECRET.length < 32) { console.error("BRIDGE_SECRET fehlt oder ist zu kurz"); process.exit(1); }

let running = 0;
const queue = [];
const slot = () => running < MAX ? (running++, Promise.resolve()) : new Promise(r => queue.push(r));
const release = () => { const next = queue.shift(); next ? next() : running--; };

function authed(req) {
  const got = Buffer.from(req.headers.authorization || ""), want = Buffer.from(`Bearer ${SECRET}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

function status() {
  return new Promise(res => execFile(CLAUDE, ["auth", "status"], { timeout: 15_000 }, (err, out) => {
    try { const j = JSON.parse(out); res({ loggedIn: !!j.loggedIn, plan: j.subscriptionType || "", method: j.authMethod || "" }); }
    catch { res({ loggedIn: false, plan: "", method: "", error: err?.message }); }
  }));
}

async function ask({ system, prompt, web, effort }) {
  await slot();
  try {
    return await new Promise((resolve, reject) => {
      const args = ["-p", "--output-format", "json", "--model", MODEL, "--system-prompt", system || "",
        "--tools", ...(web ? ["WebSearch", "WebFetch"] : [""]), "--strict-mcp-config", "--disable-slash-commands",
        "--no-session-persistence", "--setting-sources", ""];
      if (["low", "medium", "high"].includes(effort)) args.push("--effort", effort);
      /* API keys in the environment would take precedence over the subscription login */
      const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; delete env.BRIDGE_SECRET;
      const p = spawn(CLAUDE, args, { cwd: CWD, env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      const timer = setTimeout(() => p.kill("SIGTERM"), TIMEOUT);
      p.stdout.on("data", d => out += d);
      p.stderr.on("data", d => err += d);
      p.on("error", e => { clearTimeout(timer); reject(e); });
      p.on("close", code => {
        clearTimeout(timer);
        try {
          const j = JSON.parse(out);
          if (j.is_error) return reject(new Error(j.result || j.subtype || "Claude Code meldet einen Fehler"));
          resolve(j.result || "");
        } catch { reject(new Error((err || out).trim().slice(0, 500) || `Claude Code beendet mit Code ${code}`)); }
      });
      p.stdin.end(prompt);
    });
  } finally { release(); }
}

function send(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  if (!authed(req)) return send(res, 401, { error: "Nicht berechtigt" });
  try {
    if (req.method === "GET" && req.url === "/status") return send(res, 200, await status());
    if (req.method === "POST" && req.url === "/ask") {
      let raw = "";
      for await (const c of req) { raw += c; if (raw.length > 2_000_000) return send(res, 413, { error: "Anfrage zu groß" }); }
      const b = JSON.parse(raw);
      if (typeof b.prompt !== "string" || !b.prompt.trim()) return send(res, 400, { error: "prompt fehlt" });
      return send(res, 200, { text: await ask(b) });
    }
    send(res, 404, { error: "Unbekannt" });
  } catch (e) {
    send(res, 502, { error: e.message });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Bridge auf 127.0.0.1:${PORT}, Modell ${MODEL}`));
