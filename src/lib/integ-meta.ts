/* Shared between client and server. perUser = one connection per person and tenant (mailboxes).
   account = one connection per person for all their tenants (AI keys); jobs without a user take the key of a member. */
export type IntegKind = "outlook" | "imap" | "smtp" | "hubspot" | "vergabehero" | "sendpilot" | "claude" | "openrouter" | "resend";
export type Field = { id: string; label: string; type?: string; value?: string; secret?: boolean; optional?: boolean; placeholder?: string; options?: [string, string][] };

export const OPENROUTER_MODELS: [string, string][] = [
  ["anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5"],
  ["anthropic/claude-haiku-5.5", "Claude Haiku 5.5"],
  ["google/gemini-3.8-flash", "Gemini 3.8 Flash"],
  ["openai/gpt-5.6-luna", "GPT-5.6 Luna"],
];

export const INTEG: { k: IntegKind; ico: string; name: string; perUser?: boolean; account?: boolean; auth: "oauth" | "fields" | "pending"; fields?: Field[] }[] = [
  { k: "outlook", ico: "mail", name: "Microsoft 365", perUser: true, auth: "oauth" },
  { k: "imap", ico: "inbox", name: "IMAP-Postfach", perUser: true, auth: "fields", fields: [
    { id: "user", label: "E-Mail", type: "email" }, { id: "pass", label: "Passwort", type: "password", secret: true },
    { id: "host", label: "Server", optional: true, placeholder: "Automatisch" }, { id: "port", label: "Port", type: "number", value: "993" }] },
  { k: "smtp", ico: "server", name: "SMTP", perUser: true, auth: "fields", fields: [
    { id: "host", label: "Server", value: "smtp.office365.com" }, { id: "port", label: "Port", type: "number", value: "587" },
    { id: "user", label: "Benutzer", type: "email" }, { id: "pass", label: "App-Passwort", type: "password", secret: true }] },
  { k: "hubspot", ico: "database", name: "HubSpot", auth: "fields", fields: [{ id: "token", label: "Private-App-Token", type: "password", secret: true }] },
  { k: "vergabehero", ico: "landmark", name: "Vergabehero", auth: "pending" },
  { k: "sendpilot", ico: "linkedin", name: "SendPilot", auth: "pending" },
  { k: "openrouter", ico: "sparkles", name: "OpenRouter", account: true, auth: "fields", fields: [{ id: "key", label: "API-Schlüssel", type: "password", secret: true },
    { id: "model", label: "Modell", type: "select", value: OPENROUTER_MODELS[0][0], options: OPENROUTER_MODELS }] },
  { k: "claude", ico: "sparkles", name: "Claude", account: true, auth: "fields", fields: [{ id: "key", label: "API-Schlüssel", type: "password", secret: true }] },
  { k: "resend", ico: "bell", name: "Resend", auth: "fields", fields: [{ id: "key", label: "API-Schlüssel", type: "password", secret: true }, { id: "from", label: "Absender", type: "email" }] },
];
