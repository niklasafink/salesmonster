/* Filters and sorting set in a column header of the leads list. Pure, so they can be tested. */

/* what a column holds for a row: text, a number, or nothing */
export type Val = string | number | null | undefined;
/* q: words to find in the column; has: only rows with ("ja") or without ("nein") a value; v: exactly this value */
export type ColFilter = { q?: string; has?: "ja" | "nein"; v?: string };
export type ColSort = { id: string; desc: boolean } | null;

/* accent-insensitive search: "zoe" finds Zoë, "mueller" and "muller" find Müller; each word on its own, so "Schweizer Daniel" finds Daniel Schweizer */
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const umlaut = (s: string) => fold(s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss"));
export const matches = (hay: string, q: string) => { const h = fold(hay), u = umlaut(hay); return fold(q).split(/\s+/).filter(Boolean).every(w => h.includes(w) || u.includes(w)); };

export const isEmpty = (v: Val) => v == null || (typeof v === "string" && !v.trim());
export const isOn = (f?: ColFilter) => !!f && (!!f.has || !!f.v || !!f.q?.trim());

export function passes(v: Val, f: ColFilter | undefined) {
  if (!isOn(f)) return true;
  const s = isEmpty(v) ? "" : String(v);
  if (f!.has === "ja" && !s) return false;
  if (f!.has === "nein" && s) return false;
  if (f!.v && s !== f!.v) return false;
  return !f!.q?.trim() || (!!s && matches(s, f!.q));
}

/* empty values go last in both directions, numbers by size, text the German way with numbers inside counted ("Firma 2" before "Firma 10") */
export function compare(a: Val, b: Val, desc: boolean) {
  const ea = isEmpty(a), eb = isEmpty(b);
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  const d = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), "de", { numeric: true, sensitivity: "base" });
  return desc ? -d : d;
}

/* filters with nothing set are dropped, so the saved state stays small and an emptied search counts as none */
export function withFilter(all: Record<string, ColFilter>, id: string, f: ColFilter) {
  const n = { ...all };
  const clean: ColFilter = { ...(f.has ? { has: f.has } : {}), ...(f.v ? { v: f.v } : {}), ...(f.q ? { q: f.q } : {}) };
  if (isOn(clean) || clean.q) n[id] = clean; else delete n[id];
  return n;
}

/* a short text for the chip above the list, e.g. "E-Mail: leer" or "Firma: „bau“" */
export function filterText(label: string, f: ColFilter) {
  const parts = [f.has === "ja" ? "vorhanden" : f.has === "nein" ? "leer" : "", f.v || "", f.q?.trim() ? `„${f.q.trim()}“` : ""].filter(Boolean);
  return `${label}: ${parts.join(", ")}`;
}
