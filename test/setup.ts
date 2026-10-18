/* Tests run only against the Neon test branch: export TEST_DATABASE_URL (or TEST_ENV_FILE=<path to a file defining it>).
   DATABASE_URL is always overwritten, so the live database is never touched. */
import { config } from "dotenv";
import { vi } from "vitest";
import { reqStore } from "./req";

if (!process.env.TEST_DATABASE_URL && process.env.TEST_ENV_FILE) config({ path: process.env.TEST_ENV_FILE, quiet: true });
if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL fehlt: Tests laufen nur gegen den Neon-Testbranch. `export TEST_DATABASE_URL=…` oder TEST_ENV_FILE setzen.");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.APP_SECRET = "test-app-secret";

/* Route handlers read cookies() from next/headers; in tests it answers from the Request passed to call() */
vi.mock("next/headers", () => ({
  cookies: async () => {
    const raw = reqStore.getStore()?.headers.get("cookie") || "";
    const jar = new Map(raw.split(/;\s*/).filter(Boolean).map(p => { const i = p.indexOf("="); return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))] as const; }));
    return { get: (name: string) => jar.has(name) ? { name, value: jar.get(name)! } : undefined };
  },
}));
