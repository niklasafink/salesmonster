/* Shared between the builder (client) and the generator (server) */
import type { InvoiceLine, Plan } from "@/db/schema";
import { addDaysIso, addMonthsIso, dShort } from "./dates";

export type Draft = { plan: Plan; cycle: "monat" | "jahr"; price: number; start: string };

export function buildLines(d: Draft): { lines: InvoiceLine[]; end: string; item: string } {
  const months = d.cycle === "jahr" ? 12 : 1;
  const end = addDaysIso(addMonthsIso(d.start, months), -1);
  const lines: InvoiceLine[] = [{ desc: d.plan.label, sub: `${months === 12 ? "12 Monate" : "1 Monat"} (${dShort(d.start)} – ${dShort(end)})`, qty: months, unit: d.price }];
  if (months === 12 && !d.plan.noFree) lines.push({ desc: "Jahresrabatt: 2 Monate geschenkt", qty: 2, unit: -d.price, disc: true });
  return { lines, end, item: `${d.plan.n}, ${months === 12 ? "12 Monate" : "1 Monat"}` };
}

export const lineSum = (l: InvoiceLine) => Math.round(l.qty * l.unit * 100) / 100;
export const totalOf = (lines: InvoiceLine[]) => Math.round(lines.reduce((s, l) => s + lineSum(l), 0) * 100) / 100;
export const eur = (n: number) => n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
export const greeting = (salut: string) => salut ? `Sehr geehrte${/^Frau/.test(salut) ? "" : "r"} ${salut},` : "Sehr geehrte Damen und Herren,";
