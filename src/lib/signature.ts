import EmailReplyParser from "email-reply-parser";
import { z } from "zod";
import type { SigData } from "@/db";
import type { Ai } from "./ai";
import { ask, json } from "./claude";
import { salutationOf } from "./lead-fields";

/* Signatures: find the block, read it with rules, let the tenant's AI read it properly when one is connected */

const SIGNOFF = /^\s*(mit\s+)?(freundlichen|besten|herzlichen|vielen|schönen|lieben|beste|viele|liebe|herzliche|sonnige)?\s*(grüßen|grüße|gruß|grüssen|grüsse|gruss|dank)\b|^\s*(mfg|vg|lg|bg)\b|^\s*(best|kind|warm)\s+regards|^\s*(regards|cheers|thanks|best|sincerely)\s*,?\s*$|^\s*--\s*$|^\s*__+\s*$/i;
const CLOSING = /^\s*(gesendet von|sent from|von meinem|get outlook)/i;
const LEGAL = /^(geschäftsführ|registergericht|amtsgericht|handelsregister|hrb|ust|sitz der|vorstand|aufsichtsrat|diese e-?mail|this e-?mail|der inhalt|confidential|vertraulich|datenschutz|privacy|bitte prüfen|please consider)/i;

/* What a person wrote in this mail, without the quoted thread below it */
export function ownText(body: string) {
  const text = body.replace(/\r\n/g, "\n").replace(/ /g, " ");
  /* Outlook and German clients quote with a header block the parser does not know in every variant */
  const cut = text.search(/^\s*(-{2,}\s*(original|ursprüngliche)|von:\s.+\n\s*(gesendet|sent|datum|date):|from:\s.+\n\s*(sent|date):|am .{6,80} schrieb .{1,200}:\s*$|on .{6,80} wrote:\s*$)/im);
  const head = cut > 0 ? text.slice(0, cut) : text;
  try {
    return new EmailReplyParser().read(head).getFragments().filter(f => !f.isQuoted()).map(f => f.getContent()).join("\n").trim();
  } catch { return head.trim(); }
}

const lines = (s: string) => s.split("\n").map(l => l.trim()).filter(Boolean);
const key = (l: string) => l.toLowerCase().replace(/\s+/g, " ");

/* The lines a person ends every mail with are the signature; with one mail, everything after the sign-off */
export function signatureOf(bodies: string[]): string {
  const own = bodies.map(ownText).filter(Boolean).map(lines);
  if (own.length >= 2) {
    const [a, b] = own;
    let n = 0;
    while (n < a.length && n < b.length && key(a[a.length - 1 - n]) === key(b[b.length - 1 - n])) n++;
    if (n >= 2) return trim(a.slice(a.length - n));
  }
  const ls = own[0] || [];
  for (let i = ls.length - 1; i >= Math.max(0, ls.length - 30); i--) if (SIGNOFF.test(ls[i])) return trim(ls.slice(i + 1));
  return trim(ls.slice(-10));
}

/* Without the phone-app line and with at most 25 lines; the legal block stays, it often carries the company */
const trim = (ls: string[]) => ls.filter(l => !CLOSING.test(l)).slice(0, 25).join("\n");

const PHONE = /(?:\+|00)\s?\d{1,3}[\s\d()/.-]{6,}\d|\b0\d{2,5}[\s/.-]*\d[\d\s/.-]{4,}\d/;
const FORMS = String.raw`(?:GmbH\s*&\s*Co\.?\s*KG|gGmbH|GmbH|AG|SE|KGaA|KG|OHG|UG(?:\s*\(haftungsbeschränkt\))?|e\.\s?V\.|e\.\s?K\.|mbH|Ltd\.?|LLC|Inc\.?|S\.A\.|B\.V\.)(?=\W|$)`;
const LEGAL_FORM = new RegExp(String.raw`\b${FORMS}`);
const COMPANY = new RegExp(String.raw`[\p{Lu}\p{N}][\p{L}\p{N}&.'’+\- ]{0,60}?\s${FORMS}`, "u");
const ROLE = /(geschäftsführ|inhaber|vorstand|ceo|cto|cfo|coo|founder|gründer|leiter|leitung|head of|director|direktor|manager|referent|sachbearbeit|einkauf|vertrieb|prokurist|partner|berater|consultant|assistenz|projekt)/i;
const STREET = /^(.+?(straße|strasse|str\.|weg|allee|platz|ring|gasse|damm|ufer|chaussee|markt)\s*\d+\s*\w?)\b/i;
const ZIP_CITY = /\b(\d{5})\s+([A-ZÄÖÜ][\wäöüß.\- ]{1,40})/;

/* Rules alone: enough for phone, web, LinkedIn, address, often company and role */
export function readSignature(sig: string, name: string, email: string): SigData {
  const ls = lines(sig), domain = email.split("@")[1] || "";
  const pick = (re: RegExp) => ls.find(l => re.test(l)) || "";
  const phoneLine = (re: RegExp) => { const l = ls.find(x => re.test(x) && PHONE.test(x)); return l ? l.match(PHONE)![0].trim() : ""; };
  const mobile = phoneLine(/mobil|mobile|handy|\bm\s*[:.]|cell/i) || ls.map(l => l.match(PHONE)?.[0] || "").find(p => /^(\+49\s?1[5-7]|01[5-7])/.test(p.replace(/[\s()/.-]/g, ""))) || "";
  const phone = phoneLine(/tel|fon|phone|\bt\s*[:.]|durchwahl/i) || ls.map(l => l.match(PHONE)?.[0] || "").find(p => p && p !== mobile) || "";
  const web = sig.match(/\b(?:https?:\/\/)?(?:www\.)[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?/i)?.[0] || "";
  const linkedin = sig.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[^\s>)\]]+/i)?.[0] || "";
  const company = ls.filter(l => !LEGAL.test(l)).map(l => l.match(COMPANY)?.[0].trim() || "").find(Boolean) || "";
  const [first, ...rest] = name.split(/\s+/);
  const nameAt = ls.findIndex(l => name && key(l).includes(key(name)));
  const role = (nameAt >= 0 && ls[nameAt + 1] && ROLE.test(ls[nameAt + 1]) ? ls[nameAt + 1] : pick(ROLE)).replace(/[|,].*$/, "").trim().slice(0, 80);
  const street = ls.map(l => l.match(STREET)?.[1] || "").find(Boolean) || "";
  const city = sig.match(ZIP_CITY)?.[2]?.split(/[,|]/)[0].trim() || "";
  return { salutation: "", first: name ? first : "", last: name ? rest.join(" ") : "", role: ROLE.test(role) && role.length < 80 ? role : "", company,
    phone, mobile, website: web ? (web.startsWith("http") ? web : `https://${web}`) : domain ? `https://${domain}` : "", linkedin, street, city };
}

const s = () => z.string().nullish().transform(v => (v ?? "").trim());
const SigOut = z.object({ email: z.string(), salutation: s(), first: s(), last: s(), role: s(), company: s(), phone: s(), mobile: s(), website: s(), linkedin: s(), street: s(), city: s() });

/* One call for many signatures. The AI only fills what the text shows; rule results stay where it returns nothing */
export async function readSignatures(ai: Ai, xs: { email: string; name: string; signature: string; rules: SigData }[]): Promise<Map<string, SigData>> {
  const text = await ask({
    key: ai, effort: "low",
    system: "Du liest E-Mail-Signaturen deutscher und internationaler Geschäftskontakte und gibst die Angaben als JSON zurück. Du erfindest nichts.",
    prompt: `Lies je Kontakt die Signatur und den Anzeigenamen. Gib je Kontakt zurück:
email (unverändert), salutation ("Herr", "Frau", "Herr Dr.", "Frau Dr.", "Herr Prof. Dr.", "Frau Prof. Dr." oder "", nur wenn Titel, Anrede oder ein eindeutig weiblicher bzw. männlicher Vorname vorliegt), first, last (ohne Titel), role (Position, z. B. „Geschäftsführer“, „Leitung Einkauf“), company (Firmenname mit Rechtsform, wie in der Signatur), phone (Festnetz), mobile, website, linkedin (Profil-URL), street, city.
Steht etwas nicht in Signatur oder Anzeigename, gib "" zurück. Zitate, Werbebanner und Hinweise zur Vertraulichkeit ignorieren.
Antworte nur mit \`\`\`json {"contacts":[…]}\`\`\`.

${JSON.stringify(xs.map(x => ({ email: x.email, name: x.name, signature: x.signature.slice(0, 1500) })))}`,
  });
  const got = json(text, z.object({ contacts: z.array(SigOut) })).contacts;
  const out = new Map<string, SigData>();
  for (const x of xs) {
    const g = got.find(c => c.email.toLowerCase() === x.email);
    if (!g) { out.set(x.email, x.rules); continue; }
    const merged = { ...x.rules };
    for (const k of Object.keys(merged) as (keyof SigData)[]) if (g[k]) merged[k] = g[k];
    merged.salutation = salutationOf(merged.salutation);
    out.set(x.email, merged);
  }
  return out;
}
