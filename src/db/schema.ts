import { boolean, date, integer, jsonb, numeric, pgTable, serial, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

export type Tender = { t: string; s: string; f: string };

export type TenantSettings = {
  prompt: string;
  leadsPerDay: number;
  cooldownDays: number;
};

/* Jev's judgement of one rendered mail; see lib/jev.ts */
export type MailScore = { reply: number; specific: number; easyAsk: number; weakness: string; words: number; subjectLen: number };
export type TemplateScore = MailScore & { hash: string; n: number; weaknesses: Record<string, number> };

export type Plan = { key: string; n: string; m: number; label: string; noFree?: boolean };

export type InvoiceSettings = {
  logo: string;
  title: string;
  seller: { name: string; street: string; city: string; hrb: string; court: string; gf: string; tax: string; iban: string; bic: string; email: string };
  plans: Plan[];
  nextNo: number;
};

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  short: text("short").notNull(),
  phone: text("phone").notNull().default(""),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tenants = pgTable("tenants", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  initials: text("initials").notNull(),
  domain: text("domain").notNull(),
  tenders: boolean("tenders").notNull().default(false),
  settings: jsonb("settings").$type<TenantSettings>().notNull(),
  invoice: jsonb("invoice").$type<InvoiceSettings | null>(),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* Who may open a tenant. Each person works in their own tenants; nobody sees the others. */
export const members = pgTable("members", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
}, t => [uniqueIndex("members_key").on(t.tenantId, t.userId)]);

/* One row per tenant + kind (+ user for mailboxes). Secrets in config are encrypted. */
export const integrations = pgTable("integrations", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  config: text("config").notNull(),
  detail: text("detail").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("integrations_key").on(t.tenantId, t.kind, t.userId)]);

export const templates = pgTable("templates", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  name: text("name").notNull(),
  tone: text("tone").notNull().default("sie"),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  active: boolean("active").notNull().default(true),
  origin: text("origin").notNull().default(""),
  score: jsonb("score").$type<TemplateScore>(),
}, t => [uniqueIndex("templates_key").on(t.tenantId, t.key)]);

export const leads = pgTable("leads", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  company: text("company").notNull(),
  city: text("city").notNull().default(""),
  website: text("website").notNull().default(""),
  first: text("first").notNull().default(""),
  last: text("last").notNull().default(""),
  salutation: text("salutation").notNull().default(""),
  role: text("role").notNull().default(""),
  email: text("email").notNull().default(""),
  emailType: text("email_type").notNull().default("person"),
  linkedin: text("linkedin").notNull().default(""),
  hook: text("hook").notNull().default(""),
  tenders: jsonb("tenders").$type<Tender[]>().notNull().default([]),
  source: text("source").notNull().default("Claude-Recherche"),
  status: text("status").notNull().default("neu"),
  note: text("note").notNull().default(""),
  hubspotId: text("hubspot_id").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("leads_tenant").on(t.tenantId, t.status)]);

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  leadId: integer("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  batchDate: date("batch_date").notNull(),
  variant: text("variant").notNull(),
  channel: text("channel").notNull().default("mail"),
  subject: text("subject"),
  body: text("body"),
  finalSubject: text("final_subject"),
  finalBody: text("final_body"),
  status: text("status").notNull().default("entwurf"),
  senderId: integer("sender_id").references(() => users.id),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  repliedAt: timestamp("replied_at", { withTimezone: true }),
  bouncedAt: timestamp("bounced_at", { withTimezone: true }),
  hubspot: boolean("hubspot").notNull().default(false),
  score: jsonb("score").$type<MailScore>(),
  error: text("error").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("messages_tenant").on(t.tenantId, t.status), index("messages_sent").on(t.tenantId, t.sentAt)]);

export type InvoiceCustomer = { co: string; attn: string; salut: string; street: string; zip: string; city: string; vat: string; email: string; domain: string };
export type InvoiceLine = { desc: string; sub?: string; qty: number; unit: number; disc?: boolean };

export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  number: text("number").notNull(),
  customer: jsonb("customer").$type<InvoiceCustomer>().notNull(),
  item: text("item").notNull(),
  lines: jsonb("lines").$type<InvoiceLine[]>().notNull(),
  total: numeric("total", { precision: 12, scale: 2 }).notNull(),
  issueDate: date("issue_date").notNull(),
  dueDate: date("due_date").notNull(),
  serviceStart: date("service_start").notNull(),
  serviceEnd: date("service_end").notNull(),
  format: text("format").notNull(),
  leitweg: text("leitweg").notNull().default(""),
  contactId: integer("contact_id").references(() => users.id),
  status: text("status").notNull().default("offen"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("invoices_number").on(t.tenantId, t.number)]);

/* A company taken by one tenant, keyed per HubSpot portal (domain or normalized name).
   Two tenants on the same portal researching the same evening cannot both draft it. */
export const claims = pgTable("claims", {
  id: serial("id").primaryKey(),
  scope: text("scope").notNull(),
  key: text("key").notNull(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  leadId: integer("lead_id").references(() => leads.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("claims_key").on(t.scope, t.key)]);

export const runs = pgTable("runs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  ok: boolean("ok").notNull(),
  info: text("info").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
