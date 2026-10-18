import { HttpError, qp, route, tenantBySlug } from "@/lib/api";
import { aiFor, aiOptions, choiceId, choiceLabel } from "@/lib/ai";
import { act, applySetup, loadSetup, promptParts, PROMPT_KEY, type Action } from "@/lib/setup";

export const maxDuration = 300;

export const GET = route(async (req, _c, me) => {
  const t = await tenantBySlug(qp(req, "t"), me);
  const su = await loadSetup(t.id);
  /* keys already connected for the account: the tenant only picks one, no second setup */
  const options = t.settings.ai ? [] : (await aiOptions(t.id, me.id)).map(c => ({ id: choiceId(c), label: choiceLabel(c) }));
  return { setup: su, parts: promptParts(t, su), keys: PROMPT_KEY, ai: !!(await aiFor(t.id, me.id)), choose: options.length ? options : null };
});

export const POST = route(async (req, _c, me) => {
  const b = await req.json() as Action & { t: string } | { t: string; action: "apply"; prompt?: string; templates?: boolean; leads?: boolean };
  const t = await tenantBySlug(b.t, me);
  const su = await loadSetup(t.id);
  if (b.action === "apply") return { applied: await applySetup(t, su, b) };
  if (!["start", "message", "auto", "next", "skip", "goto", "votes", "prompt"].includes(b.action)) throw new HttpError(400, "Unbekannte Aktion");
  const next = await act(t, await aiFor(t.id, me.id), su, b);
  return { setup: next, parts: promptParts(t, next), keys: PROMPT_KEY };
});
