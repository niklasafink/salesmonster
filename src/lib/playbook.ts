/* What we know about cold mails that get answered. Fed to Claude when it rewrites templates.
   Sources: Reddit study of 6,337 cold mails (via Instagram, Oct 2026), BusySeed wording study (287,790 mails, 2026).
   Both are observational; our own reply data overrides them once there is enough of it. */
export const PLAYBOOK = `Regeln für Erstkontakt-Mails im B2B-Mittelstand:
- Unter 100 Wörtern. In einer Auswertung von 6.337 Kaltmails lag die Antwortquote unter 100 Wörtern bei rund 12 %, bei 100 bis 200 Wörtern bei rund 2 %.
- Betreff unter 30 Zeichen, gern ein bis drei Wörter, ohne Werbesprache.
- Der erste Satz handelt vom Empfänger, nicht vom Absender.
- Ein konkreter Anlass, der nur auf diese Firma passt (bei uns: die gefundenen Ausschreibungen).
- Belege lieber mit Zeitangaben oder einem konkreten Fall als mit Prozentzahlen. Prozentangaben schnitten in einer Studie mit 287.790 Mails am schlechtesten ab.
- Genau eine Bitte am Ende, die sich in einem Satz beantworten lässt. Kein Termin, keine Demo, kein Link im Erstkontakt.
- Keine Floskeln („Ich hoffe, es geht Ihnen gut“), keine Superlative, keine Ausrufezeichen.
- Höchstens zwei Nachfassmails.`;

export const words = (s: string) => s.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;

/* Cheap checks before anything goes to Jev or a real inbox */
export function lint(subject: string, body: string, required: string[]) {
  const out: string[] = [];
  const w = words(body.replace(/{{[a-z]+}}/g, "x"));
  if (w > 110) out.push(`${w} Wörter`);
  if (subject.replace(/{{firma}}/g, "Firma GmbH").length > 45) out.push("Betreff zu lang");
  for (const p of required) if (!body.includes(p) && !subject.includes(p)) out.push(`${p} fehlt`);
  const unknown = unknownPlaceholders(`${subject} ${body}`, [...required, ...ALLOWED]);
  if (unknown.length) out.push(`unbekannt: ${unknown.join(", ")}`);
  if (/https?:\/\//.test(body)) out.push("Link im Erstkontakt");
  return out;
}

/* Every {{…}} not in allowed, each once; spaces or capitals inside the braces count as unknown, fill() would leave them in the mail */
export const unknownPlaceholders = (text: string, allowed: string[]) =>
  [...new Set([...text.matchAll(/{{[^}]*}}/g)].map(m => m[0]))].filter(p => !allowed.includes(p));

/* Template keys A…Z, then AA…ZZ: the first one not taken */
export const nextKey = (taken: Set<string>) =>
  Array.from({ length: 26 * 27 }, (_, i) => i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + i % 26)).find(k => !taken.has(k))!;

const ALLOWED = ["{{anrede}}", "{{firma}}", "{{vorname}}", "{{nachname}}", "{{ausschreibungen}}", "{{aufhaenger}}", "{{absender}}"];
