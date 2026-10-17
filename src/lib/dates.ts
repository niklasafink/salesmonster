/* All business dates are Europe/Berlin */
const TZ = "Europe/Berlin";

export function berlinDate(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return p; // YYYY-MM-DD
}

export function berlinWeekday(d = new Date()) {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(d);
}

export function addDaysIso(iso: string, n: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function addMonthsIso(iso: string, n: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

export const dShort = (iso: string) => { const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`; };
export const dLong = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" });
