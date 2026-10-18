/* How the contacts of one company are written to; shared by the evening run and the lead list */
export type Mode = "einzeln" | "alle" | "eine";

export const addrsOf = (contacts: { email: string }[]) => [...new Set(contacts.map(l => l.email.trim().toLowerCase()).filter(Boolean))];

/* The stored mode, or by default: one mail per person when they have different addresses, else one mail to the shared one */
export function modeOf(c: { mode: string; email: string }, contacts: { email: string }[]): { mode: Mode; to: string[] } {
  const addrs = addrsOf(contacts);
  if (c.mode === "alle" && addrs.length > 1) return { mode: "alle", to: addrs };
  if (c.mode === "einzeln") return { mode: "einzeln", to: addrs };
  if (c.mode === "eine" || (!c.mode && addrs.length <= 1)) {
    const pick = addrs.includes(c.email.toLowerCase()) ? c.email.toLowerCase() : addrs[0];
    return { mode: "eine", to: pick ? [pick] : [] };
  }
  return { mode: "einzeln", to: addrs };
}
