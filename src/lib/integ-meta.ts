/* Shared between client and server. perUser = one connection per person (mailboxes). */
export type IntegKind = "outlook" | "smtp" | "hubspot" | "vergabehero" | "sendpilot" | "claude" | "jev" | "resend";
export type Field = { id: string; label: string; type?: string; value?: string; secret?: boolean };

export const INTEG: { k: IntegKind; ico: string; name: string; perUser?: boolean; auth: "oauth" | "fields" | "pending"; fields?: Field[] }[] = [
  { k: "outlook", ico: "mail", name: "Microsoft 365", perUser: true, auth: "oauth" },
  { k: "smtp", ico: "server", name: "SMTP", perUser: true, auth: "fields", fields: [
    { id: "host", label: "Server", value: "smtp.office365.com" }, { id: "port", label: "Port", type: "number", value: "587" },
    { id: "user", label: "Benutzer", type: "email" }, { id: "pass", label: "App-Passwort", type: "password", secret: true }] },
  { k: "hubspot", ico: "database", name: "HubSpot", auth: "fields", fields: [{ id: "token", label: "Private-App-Token", type: "password", secret: true }] },
  { k: "vergabehero", ico: "landmark", name: "Vergabehero", auth: "pending" },
  { k: "sendpilot", ico: "linkedin", name: "SendPilot", auth: "pending" },
  { k: "claude", ico: "sparkles", name: "Claude", auth: "fields", fields: [{ id: "key", label: "API-Schlüssel", type: "password", secret: true }] },
  { k: "jev", ico: "target", name: "Jev", auth: "fields", fields: [{ id: "key", label: "AI-Gateway-Schlüssel", type: "password", secret: true }] },
  { k: "resend", ico: "bell", name: "Resend", auth: "fields", fields: [{ id: "key", label: "API-Schlüssel", type: "password", secret: true }, { id: "from", label: "Absender", type: "email" }] },
];
