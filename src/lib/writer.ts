import { z } from "zod";
import { ask, json } from "./claude";
import { AiMissing, aiFor, openrouterAsk } from "./ai";
import { getInteg } from "./integrations";
import { PLAYBOOK } from "./playbook";

/* Grok writes the mails, Jev judges them, Claude researches. Grok runs on the account's OpenRouter key;
   without one the tenant's own AI writes. */
export const GROK = "x-ai/grok-4.7";

export const WRITER = `Du schreibst deutsche Erstkontakt-Mails für den B2B-Mittelstand. Kurz schlägt lang: Halte jede Mail unter 100 Wörtern, besser 50 bis 80.
${PLAYBOOK}
- Betreff: ein bis drei Wörter, unter 30 Zeichen.
- Behalte Anrede (Sie oder Du), Grußzeile und Absender der Vorlage.`;

const Out = z.object({ variants: z.array(z.object({ name: z.string().nullish().transform(v => v ?? ""), subject: z.string().min(2), body: z.string().min(20) })) });

export async function writeMails(tenantId: number, prompt: string, n: number, userId?: number) {
  const task = `${prompt}\n\nSchreibe ${n} Fassungen, die sich in einem klaren Punkt unterscheiden. Antworte nur mit \`\`\`json {"variants":[{"name":"zwei Wörter","subject":"…","body":"…"}]}\`\`\`.`;
  const or = await getInteg(tenantId, "openrouter", userId);
  let text: string;
  if (or?.key) text = await openrouterAsk({ key: or.key, model: GROK }, WRITER, [{ role: "user", content: task }], false, 0);
  else {
    const ai = await aiFor(tenantId, userId);
    if (!ai) throw new AiMissing();
    text = await ask({ key: ai, effort: "high", system: WRITER, prompt: task });
  }
  return json(text, Out).variants.slice(0, n);
}
