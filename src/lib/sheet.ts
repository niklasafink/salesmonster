/* Delimiter = the one of ; , tab that occurs most often outside quotes in the first line */
function delimiter(text: string) {
  const counts: Record<string, number> = { ";": 0, ",": 0, "\t": 0 };
  let q = false;
  for (const ch of text) {
    if (ch === '"') q = !q;
    else if (!q && (ch === "\n" || ch === "\r")) break;
    else if (!q && ch in counts) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

export function parseCsv(text: string): string[][] {
  text = text.replace(/^﻿/, "");
  const d = delimiter(text), rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else q = false;
    } else if (ch === '"') q = true;
    else if (ch === d) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export const MAX_ROWS = 1000;
const p2 = (n: number) => String(n).padStart(2, "0");
/* Excel dates arrive as UTC midnight */
const cellText = (v: unknown) => v == null ? "" : v instanceof Date ? `${p2(v.getUTCDate())}.${p2(v.getUTCMonth() + 1)}.${v.getUTCFullYear()}` : String(v).replace(/[\t\r\n]+/g, " ").trim();

/* First non-empty row is the header; the parser maps columns by it */
export function toTsv(rows: unknown[][]): string {
  const lines = rows.map(r => r.map(cellText)).filter(r => r.some(Boolean));
  if (lines.length < 2) throw new Error("Datei ist leer");
  if (lines.length - 1 > MAX_ROWS) throw new Error("Mehr als 1.000 Datenzeilen");
  return lines.map(r => r.join("\t")).join("\n");
}

/* Tab-separated table with header: pieces of `size` data rows, header repeated, so each AI parse stays well inside its
   input and output limits. Anything else (pasted free text) stays one piece. */
export function tsvChunks(text: string, size = 120): string[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2 || !lines.every(l => l.includes("\t"))) return [text];
  const [head, ...rows] = lines, out: string[] = [];
  for (let i = 0; i < rows.length; i += size) out.push([head, ...rows.slice(i, i + size)].join("\n"));
  return out;
}
