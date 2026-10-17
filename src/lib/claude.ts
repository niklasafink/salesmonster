import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const MODEL = "claude-sonnet-5-5";

type Opts = { key: string; system: string; prompt: string; web?: boolean; maxSearches?: number; effort?: "low" | "medium" | "high" };

/* One task: streams, resumes pause_turn, returns the final text */
async function ask({ key, system, prompt, web, maxSearches = 20, effort = "medium" }: Opts): Promise<string> {
  const client = new Anthropic({ apiKey: key });
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: "user", content: prompt }];
  const tools: Anthropic.Beta.Messages.BetaToolUnion[] = web
    ? [{ type: "web_search_20260209", name: "web_search", max_uses: maxSearches, user_location: { type: "approximate", country: "DE", timezone: "Europe/Berlin" } },
       { type: "web_fetch_20260209", name: "web_fetch", max_uses: maxSearches }]
    : [];
  for (let turn = 0; turn < 6; turn++) {
    const msg = await client.beta.messages.stream({
      model: MODEL, max_tokens: 32000, system, messages, tools: tools.length ? tools : undefined,
      output_config: { effort },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    } as Anthropic.Beta.Messages.MessageCreateParamsStreaming).finalMessage();
    if (msg.stop_reason === "refusal") throw new Error("Claude hat die Anfrage abgelehnt");
    if (msg.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: msg.content as Anthropic.Beta.Messages.BetaContentBlockParam[] }); continue; }
    return msg.content.filter(b => b.type === "text").map(b => (b as { text: string }).text).join("\n");
  }
  throw new Error("Claude hat die Aufgabe nicht abgeschlossen");
}

function json<T>(text: string, schema: z.ZodType<T>): T {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1]);
  const candidates = [...fenced.reverse(), text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1), text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)];
  for (const c of candidates) {
    try { const r = schema.safeParse(JSON.parse(c)); if (r.success) return r.data; } catch { /* next */ }
  }
  throw new Error("Antwort von Claude war kein gültiges JSON");
}

const s = () => z.string().nullish().transform(v => (v ?? "").trim());
const Tender = z.object({ t: s(), s: s(), f: s() });
export const LeadOut = z.object({
  company: z.string().min(2), city: s(), website: s(), first: s(), last: s(), salutation: s(), role: s(),
  email: s(), emailType: z.enum(["person", "info"]).catch("person"), linkedin: s(), hook: s(),
  tenders: z.array(Tender).catch([]),
});
export type LeadOut = z.infer<typeof LeadOut>;

const LEAD_FORMAT = `Antworte am Ende mit genau einem JSON-Block in \`\`\`json, Form:
{"leads":[{"company":"Firma GmbH","city":"Ort","website":"https://…","first":"Vorname","last":"Nachname","salutation":"Herr|Frau","role":"Rolle","email":"adresse","emailType":"person|info","linkedin":"URL oder leer","hook":"Anlass als Substantivgruppe im Nominativ oder leer","tenders":[{"t":"Titel","s":"Vergabestelle","f":"Frist TT.MM."}]}]}
Leere Felder als "". Erfinde keine Namen oder Adressen: nur, was du auf einer Quelle gesehen hast.`;

export async function researchLeads(key: string, prompt: string, n: number, exclude: string[], focus: string, tenders: boolean) {
  const text = await ask({
    key, effort: "medium", web: true, maxSearches: 10 + n * 4,
    system: `${prompt}\n\nDu arbeitest als Recherche-Assistent für Vertrieb im Mittelstand. ${LEAD_FORMAT}`,
    prompt: `Finde heute ${n} neue Unternehmen mit Ansprechpartner und E-Mail-Adresse.${focus ? ` Schwerpunkt dieser Runde: ${focus}.` : ""}
${tenders ? "Suche je Unternehmen bis zu drei laufende öffentliche Ausschreibungen, die zum Gewerk passen (z. B. über service.bund.de, evergabe-online.de, DTVP), mit Titel, Vergabestelle und Frist." : "Nenne je Unternehmen den aktuellen Anlass als hook."}
Diese Unternehmen sind schon bekannt und dürfen nicht vorkommen:
${exclude.slice(0, 400).join("; ") || "(keine)"}`,
  });
  return json(text, z.object({ leads: z.array(LeadOut) })).leads.slice(0, n);
}

export async function enrichLead(key: string, prompt: string, lead: Partial<LeadOut> & { company: string }, tenders: boolean) {
  const text = await ask({
    key, effort: "low", web: true, maxSearches: 8,
    system: `${prompt}\n\n${LEAD_FORMAT}`,
    prompt: `Ergänze fehlende Angaben zu diesem Lead (Ansprechpartner, E-Mail, Website${tenders ? ", bis zu drei passende laufende Ausschreibungen" : ", Anlass"}). Behalte vorhandene Angaben.
${JSON.stringify(lead)}`,
  });
  return json(text, z.object({ leads: z.array(LeadOut) })).leads[0] ?? null;
}

const ImportRow = z.object({ co: z.string().min(2), p: s(), role: s(), email: s(), web: s(), city: s() });
export async function parseImport(key: string, raw: string) {
  const text = await ask({
    key, effort: "low",
    system: "Du liest unstrukturierte Listen (Bieterlisten, Tabellen, Freitext) und gibst Firmen als JSON zurück.",
    prompt: `Erkenne alle Firmen in diesem Text. Je Firma: co (Firmenname mit Rechtsform), p (Ansprechpartner Vor- und Nachname), role (Rolle wie Geschäftsführung, Inhaber), email, web (Website), city (Ort).
Nichts erfinden. Antworte nur mit \`\`\`json {"rows":[…]}\`\`\`.

${raw.slice(0, 40000)}`,
  });
  return json(text, z.object({ rows: z.array(ImportRow) })).rows;
}

const Imp = z.object({ street: s(), zip: s(), city: s(), gf: s(), vat: s(), hrb: s() });
export async function impressum(key: string, domain: string) {
  const text = await ask({
    key, effort: "low", web: true, maxSearches: 4,
    system: "Du liest Impressumsseiten deutscher Unternehmen und gibst die Angaben als JSON zurück.",
    prompt: `Lies das Impressum von https://${domain} (zum Beispiel /impressum). Gib zurück: street (Straße und Hausnummer), zip, city, gf (erste:r Geschäftsführer:in mit Anrede und Nachname, z. B. "Herr Gimbel"), vat (USt-IdNr. oder leer), hrb (Handelsregisternummer oder leer).
Antworte nur mit \`\`\`json {…}\`\`\`.`,
  });
  return json(text, Imp);
}

const TplOut = z.object({ name: s(), subject: z.string().min(3), body: z.string().min(20) });
/* Rewrites one template into new variants; the caller scores them with Jev */
export async function proposeTemplates(key: string, brief: string, n: number) {
  const text = await ask({
    key, effort: "high",
    system: "Du schreibst kurze deutsche Erstkontakt-Mails für den B2B-Mittelstand. Du verbesserst Vorlagen anhand von Messwerten und Regeln, nicht nach Geschmack.",
    prompt: `${brief}

Schreibe ${n} neue Varianten, die sich in einem klaren Punkt unterscheiden. Verwende nur die genannten Platzhalter. Antworte nur mit \`\`\`json {"variants":[{"name":"zwei Wörter","subject":"…","body":"…"}]}\`\`\`.`,
  });
  return json(text, z.object({ variants: z.array(TplOut) })).variants.slice(0, n);
}
