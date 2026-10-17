import { HttpError, qp, route, tenantBySlug } from "@/lib/api";
import { aiFor } from "@/lib/ai";
import { act, applySetup, buildPrompt, loadSetup, type Action } from "@/lib/setup";

export const maxDuration = 300;

export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  const su = await loadSetup(t.id);
  return { setup: su, prompt: buildPrompt(t, su), ai: !!(await aiFor(t.id)) };
});

export const POST = route(async (req, _c, me) => {
  const b = await req.json() as Action & { t: string } | { t: string; action: "apply"; prompt?: string; templates?: boolean; leads?: boolean };
  const t = await tenantBySlug(b.t, me);
  const su = await loadSetup(t.id);
  if (b.action === "apply") return { applied: await applySetup(t, su, b) };
  if (!["start", "message", "auto", "next", "skip", "goto", "votes"].includes(b.action)) throw new HttpError(400, "Unbekannte Aktion");
  const next = await act(t, await aiFor(t.id), su, b);
  return { setup: next, prompt: buildPrompt(t, next) };
});
