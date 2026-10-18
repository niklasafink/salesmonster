import type { TenantSettings } from "@/db/schema";
import { addDaysIso, berlinDate } from "./dates";

/* When a tenant writes to people: weekdays 1 = Monday … 7 = Sunday, hours [from, to) Berlin time */
export type SendPlan = { days: number[]; from: number; to: number };
export const DAY_NAMES = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

export const planOf = (s: Pick<TenantSettings, "sendDays" | "sendFrom" | "sendTo">): SendPlan => {
  const days = (s.sendDays || []).filter(d => Number.isInteger(d) && d >= 1 && d <= 7);
  const from = Number.isInteger(s.sendFrom) ? s.sendFrom! : 8, to = Number.isInteger(s.sendTo) ? s.sendTo! : 10;
  return { days: days.length ? [...new Set(days)].sort() : [1, 2, 3, 4, 5], from, to: to > from ? to : from + 1 };
};

export const isoWeekday = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay() || 7;
export const berlinHour = (d = new Date()) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hourCycle: "h23" }).format(d));
export const isSendDay = (p: SendPlan, iso: string) => p.days.includes(isoWeekday(iso));

/* The first send day on or after iso */
export function sendDayFrom(p: SendPlan, iso: string) {
  let d = iso;
  for (let i = 0; i < 7 && !isSendDay(p, d); i++) d = addDaysIso(d, 1);
  return d;
}

/* The send days the next k evening runs fill, one batch each; today's evening counts while its batch is not made yet */
export function batchDays(p: SendPlan, k: number, ranToday: boolean, now = new Date()) {
  const out: string[] = [];
  let eve = berlinDate(now);
  if (ranToday) eve = addDaysIso(eve, 1);
  for (let i = 0; out.length < k && i < 7 * (k + 1); i++, eve = addDaysIso(eve, 1)) if (isSendDay(p, addDaysIso(eve, 1))) out.push(addDaysIso(eve, 1));
  return out;
}

/* When a drafted batch goes out: the send day after its evening, or the next one still open if that has passed */
export function draftDay(p: SendPlan, batchDate: string, now = new Date()) {
  const today = berlinDate(now);
  let d = sendDayFrom(p, addDaysIso(batchDate, 1) > today ? addDaysIso(batchDate, 1) : today);
  if (d === today && berlinHour(now) >= p.to) d = sendDayFrom(p, addDaysIso(today, 1));
  return d;
}

/* How many of the waiting messages go out now: none outside the window, else an even share of the hours left, everything in the last hour */
export function sendQuota(p: SendPlan, waiting: number, now = new Date()) {
  const h = berlinHour(now);
  if (!waiting || !isSendDay(p, berlinDate(now)) || h < p.from || h >= p.to) return 0;
  return Math.ceil(waiting / (p.to - h));
}

/* "Mo–Fr", "So–Do", "Mo, Mi, Fr", "täglich" */
export function daysText(days: number[]) {
  if (days.length >= 7) return "täglich";
  /* start after a gap, so a run across the weekend reads So–Do */
  const start = days.find(d => !days.includes(d === 1 ? 7 : d - 1)) ?? days[0];
  const list = Array.from({ length: 7 }, (_, i) => (start - 1 + i) % 7 + 1).filter(d => days.includes(d));
  const run = list.every((d, i) => !i || d === list[i - 1] % 7 + 1);
  return run && list.length > 2 ? `${DAY_NAMES[list[0] - 1]}–${DAY_NAMES[list.at(-1)! - 1]}` : list.map(d => DAY_NAMES[d - 1]).join(", ");
}
export const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
