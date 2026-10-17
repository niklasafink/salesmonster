/* Placeholder rendering, shared by the review screen and the sender */
export type FillLead = { company: string; first: string; last: string; salutation: string; emailType: string; hook: string; tenders: { t: string; s: string }[] };
export type FillTpl = { tone: string; subject: string; body: string };

export function anrede(tpl: FillTpl, l: FillLead) {
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
