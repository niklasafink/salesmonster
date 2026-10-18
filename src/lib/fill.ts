/* Placeholder rendering, shared by the review screen and the sender */
export type FillPerson = { first: string; last: string; salutation: string };
export type FillLead = { company: string; first: string; last: string; salutation: string; emailType: string; hook: string; tenders: { t: string; s: string }[]; people?: FillPerson[] };
export type FillTpl = { tone: string; subject: string; body: string };

const list = (xs: string[]) => xs.length > 1 ? `${xs.slice(0, -1).join(", ")} und ${xs[xs.length - 1]}` : xs[0];

export function anrede(tpl: FillTpl, l: FillLead) {
  /* one mail to several people names all of them */
  const ppl = (l.people || []).filter(p => p.last);
  if (ppl.length > 1) {
    if (tpl.tone === "du") return `Hallo ${list(ppl.map(p => p.first || p.last))},`;
    return `Guten Tag ${list(ppl.map(p => p.salutation ? `${p.salutation} ${p.last}` : `${p.first} ${p.last}`))},`;
  }
  const named = l.emailType === "person" && l.last;
  if (!named) return tpl.tone === "du" ? "Hallo zusammen," : "Guten Tag,";
  if (tpl.tone === "du") return `Hallo ${l.first || l.last},`;
  return l.salutation ? `Guten Tag ${l.salutation} ${l.last},` : `Guten Tag ${l.first} ${l.last},`;
}

export function fill(str: string, l: FillLead, tpl: FillTpl, sender: string) {
  const tenders = (l.tenders || []).map(t => `• ${t.t} (${t.s})`).join("\n");
  return str
    .replace(/{{anrede}}/g, anrede(tpl, l))
    .replace(/{{firma}}/g, l.company)
    .replace(/{{vorname}}/g, l.first || "")
    .replace(/{{nachname}}/g, l.last || "")
    .replace(/{{ausschreibungen}}/g, tenders)
    .replace(/{{aufhaenger}}/g, l.hook || "")
    .replace(/{{absender}}/g, sender);
}

export const PLACEHOLDERS = (tenders: boolean) => ["{{anrede}}", "{{firma}}", "{{vorname}}", "{{nachname}}", tenders ? "{{ausschreibungen}}" : "{{aufhaenger}}", "{{absender}}"];
