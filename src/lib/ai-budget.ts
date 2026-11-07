import { gte, sql } from "drizzle-orm";
import { db, aiUsage } from "@/db";

/* OpenRouter is locked unless OPENROUTER_MONTHLY_USD allows it: 0 or unset blocks every call, a positive number allows calls
   until the month's recorded cost (ai_usage, all tenants, UTC month) reaches it. Lead work runs over MCP on the Claude plan instead.
   The check runs before a call, so one running action can still finish above the cap; the hard stop is the key limit at OpenRouter. */
const BUDGET = Math.max(0, Number(process.env.OPENROUTER_MONTHLY_USD) || 0);

let cache: { at: number; ok: boolean } | null = null;

export async function openrouterAllowed(): Promise<boolean> {
  if (!BUDGET) return false;
  if (cache && Date.now() - cache.at < 60_000) return cache.ok;
  const now = new Date(), month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [r] = await db.select({ micro: sql<string>`coalesce(sum(${aiUsage.cost}), 0)` }).from(aiUsage).where(gte(aiUsage.startedAt, month));
  const ok = Number(r?.micro || 0) / 1e6 < BUDGET;
  if (!ok) console.warn(`OpenRouter gesperrt: Monatsbudget ${BUDGET} $ erreicht`);
  cache = { at: Date.now(), ok };
  return ok;
}
