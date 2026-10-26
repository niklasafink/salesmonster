/* Lead or CRM: a lead is someone the research or an import brought in to be written to; CRM is someone who registered on the
   website (HubSpot leads, see lib/crm-sync.ts). A lead who registers later is both. */
export type Kind = "lead" | "crm" | "beides";
/* the view's choice: leads (with those who are both), CRM (likewise) or everyone */
export type KindFilter = "alle" | "lead" | "crm";

type K = { prospect: boolean; crmAt: string | Date | null };

export const kindOf = (l: K): Kind => l.crmAt ? (l.prospect ? "beides" : "crm") : "lead";
export const inKind = (l: K, f: KindFilter) => f === "alle" || (f === "lead" ? l.prospect : !!l.crmAt);

export const KIND_LABEL: Record<Kind, string> = { lead: "Lead", crm: "CRM", beides: "Lead + CRM" };

/* a company is what its people are: CRM when one of them registered, a lead when one came from research or import */
export function kindOfAll(ls: K[]): Kind {
  const crm = ls.some(l => l.crmAt), lead = ls.some(l => l.prospect);
  return crm && lead ? "beides" : crm ? "crm" : "lead";
}
