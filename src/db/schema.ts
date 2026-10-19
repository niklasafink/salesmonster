import { sql } from "drizzle-orm";
import { bigint, boolean, date, integer, jsonb, numeric, pgTable, real, serial, text, timestamp, uniqueIndex, index, type AnyPgColumn } from "drizzle-orm/pg-core";

export type Tender = { t: string; s: string; f: string };

/* Which connected AI a tenant uses; the keys themselves belong to the account, so tenants can share one or differ */
export type AiChoice = { kind: "claude"; model?: string } | { kind: "openrouter" | "requesty" | "openai"; model: string };

export type TenantSettings = {
  prompt: string;
  leadsPerDay: number;
  cooldownDays: number;
  ai?: AiChoice;
  /* research rounds per day besides the evening run (0 = off), and whether grade-A leads wait for Tuesday/Wednesday */
  roundsPerDay?: number;
  holdTop?: boolean;
  /* when mails go out (lib/schedule.ts): weekdays 1 = Monday … 7 = Sunday, hours [sendFrom, sendTo) Berlin; default Mo–Fr 8–10 */
  sendDays?: number[];
  sendFrom?: number;
  sendTo?: number;
  /* SendPilot campaign the evening run hands LinkedIn leads to; unset = they wait for the LinkedIn button */
  sendpilotCampaign?: string;
  /* places whose open leads go first, set by the lead chat; leads found later from there join the front before each evening run */
  firstPlaces?: string[];
  /* notes from reading the tenant's website once in the setup; read again only when the domain changes */
  site?: { domain: string; notes: string; at: string };
};

/* Jev's judgement of one rendered mail; see lib/jev.ts */
export type MailScore = { reply: number; specific: number; easyAsk: number; weakness: string; words: number; subjectLen: number;
  /* draft score 0–100 with what lowers it (lib/draft-score.ts), the text it belongs to, and the calibrated reply rate once there is data */
  total?: number; issues?: string[]; hash?: string; expected?: number };
export type TemplateScore = MailScore & { hash: string; n: number; weaknesses: Record<string, number> };

/* lib/lead-fit.ts: the model's judgement behind leads.fit, parts 0–4; hash says on which inputs it was made */
export type FitInfo = { company: number; person: number; need: number; evidence: number; segment: string; ko: string; why: string; model: string; hash: string; at: string };
export type RatingInfo = { grade: "A" | "B" | "C" | "D"; expected: number; parts: Record<"fit" | "reach" | "role" | "timing" | "feedback", number>; reasons: { pts: number; text: string; learned?: boolean }[] };

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

/* Link to join a tenant; single use, valid for 7 days */
export const invites = pgTable("invites", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  createdBy: integer("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

/* One row per tenant + kind (+ user for mailboxes); account-wide keys have no tenant. Secrets in config are encrypted. */
export const integrations = pgTable("integrations", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
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

/* A company with one or more contacts. mode decides how they are written to:
   "einzeln" one mail per person, "alle" one mail to all addresses, "eine" one mail to `email`; "" picks by the addresses */
export const companies = pgTable("companies", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  name: text("name").notNull(),
  mode: text("mode").notNull().default(""),
  email: text("email").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("companies_key").on(t.tenantId, t.key)]);

/* what a web search can fill in; person = salutation, first and last name (with the role when it is empty too) */
export type EnrichField = "person" | "role" | "email" | "phone" | "linkedin" | "website" | "city";

export const leads = pgTable("leads", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  companyId: integer("company_id").references(() => companies.id, { onDelete: "set null" }),
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
  /* where the data was found, and the research text as it came in */
  sourceUrl: text("source_url").notNull().default(""),
  research: text("research").notNull().default(""),
  status: text("status").notNull().default("neu"),
  note: text("note").notNull().default(""),
  hubspotId: text("hubspot_id").notNull().default(""),
  phone: text("phone").notNull().default(""),
  /* last mail in either direction, for contacts that came from a mailbox */
  lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
  /* lib/lead-rating.ts: score 0–100 (null = not rated), with grade, parts and reasons; fit is Jev's 0–4 match with the ideal customer */
  rating: integer("rating"),
  ratingInfo: jsonb("rating_info").$type<RatingInfo | null>(),
  fit: real("fit"),
  fitInfo: jsonb("fit_info").$type<FitInfo | null>(),
  vote: integer("vote").notNull().default(0),
  angleId: integer("angle_id").references((): AnyPgColumn => angles.id, { onDelete: "set null" }),
  /* fields a web search looked for and did not find, with when; the next search skips them unless asked to look again */
  enrichMiss: jsonb("enrich_miss").$type<Partial<Record<EnrichField, string>>>().notNull().default({}),
  /* channel set by hand (mail | linkedin), empty = as recommended (lib/lead-rating.ts channelOf); place in the send queue set by drag and drop;
     when the lead went to SendPilot, after which it is never mailed */
  channel: text("channel").notNull().default(""),
  queueRank: integer("queue_rank"),
  sendpilotAt: timestamp("sendpilot_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("leads_tenant").on(t.tenantId, t.status), index("leads_rating").on(t.tenantId, t.rating)]);

/* A search direction of the research (e.g. an industry plus a trigger). Thompson sampling picks one per round by how its leads did;
   the AI adds new ones and pauses weak ones it made, the user's own ones only the user pauses. origin: start | ki | nutzer */
export const angles = pgTable("angles", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  query: text("query").notNull().default(""),
  origin: text("origin").notNull().default("ki"),
  active: boolean("active").notNull().default(true),
  rounds: integer("rounds").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("angles_tenant").on(t.tenantId)]);

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  leadId: integer("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  /* every lead this message covers (leadId first) and the addresses it goes to; empty for older single mails */
  leadIds: jsonb("lead_ids").$type<number[]>().notNull().default([]),
  to: text("to").notNull().default(""),
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
  /* text rewritten by "Verbessern"; compared against untouched drafts in the stats */
  improved: boolean("improved").notNull().default(false),
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

/* Guided setup: the AI interviews the user step by step and fills these, then writes prompt and templates */
export const SETUP_STEPS = ["website", "zielgruppe", "ansprechpartner", "liste", "ansprache", "fertig"] as const;
export type SetupStep = typeof SETUP_STEPS[number];
export type Profile = { name: string; summary: string; offer: string; valueProps: string[]; customers: string[]; proof: string[]; regions: string[]; language: string; pricing: string;
  /* added 2026-10-18, older rows lack them */
  audience?: string; goal?: string; ask?: string; giveaway?: string; alternatives?: string[]; objections?: string[]; rules?: string[]; words?: string[]; known?: string[] };
export type Segment = { name: string; industries: string[]; size: string; regions: string[]; triggers: string[]; why: string; exclude: string[] };
export type Persona = { role: string; titles: string[]; segment: string; pains: string[]; goals: string[]; query: string };
export type SetupLead = { company: string; website: string; city: string; segment: string; person: string; role: string; linkedin: string; email: string; why: string; vote?: 1 | -1; reason?: string };
export type SetupTemplate = { key: string; name: string; tone: string; subject: string; body: string; score?: MailScore | null };
export type ChatMsg = { role: "ai" | "me"; text: string; step: SetupStep; chips?: string[] };
/* who filled a step: the AI on its own, the AI from the user's answer or a hand edit, or a research run outside the chat */
export type StepSource = "ki" | "nutzer" | "recherche";

export const setups = pgTable("setups", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  /* a tenant can start the setup over in a new chat; the older chats stay, exactly one is active */
  active: boolean("active").notNull().default(true),
  step: text("step").$type<SetupStep>().notNull().default("website"),
  profile: jsonb("profile").$type<Profile | null>(),
  segments: jsonb("segments").$type<Segment[]>().notNull().default([]),
  personas: jsonb("personas").$type<Persona[]>().notNull().default([]),
  leads: jsonb("leads").$type<SetupLead[]>().notNull().default([]),
  templates: jsonb("templates").$type<SetupTemplate[]>().notNull().default([]),
  chat: jsonb("chat").$type<ChatMsg[]>().notNull().default([]),
  skipped: jsonb("skipped").$type<SetupStep[]>().notNull().default([]),
  /* hand-edited prompt sections per step; the AI writing that step again drops the edit */
  prompts: jsonb("prompts").$type<Partial<Record<SetupStep, string>>>().notNull().default({}),
  sources: jsonb("sources").$type<Partial<Record<SetupStep, StepSource>>>().notNull().default({}),
  doneAt: timestamp("done_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("setups_active").on(t.tenantId).where(sql`${t.active}`)]);

export const runs = pgTable("runs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  ok: boolean("ok").notNull(),
  info: text("info").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* One row per Claude connector login; refreshHash stays null until the code is exchanged, which makes codes single-use */
export const oauthGrants = pgTable("oauth_grants", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  clientName: text("client_name").notNull(),
  refreshHash: text("refresh_hash").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/* What a workflow may write into the portal */
export const WRITES = ["leads_add", "leads_update", "templates", "report"] as const;
export type Write = typeof WRITES[number];
export type RunCounts = { added: number; skipped: number; updated: number; templates: number };

/* A recurring task Claude runs over the connector; instructions are its prompt */
export const workflows = pgTable("workflows", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  instructions: text("instructions").notNull().default(""),
  writes: jsonb("writes").$type<Write[]>().notNull().default([]),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* One start of a workflow from Claude; "läuft" older than 24 h reads as "abgebrochen" */
export const workflowRuns = pgTable("workflow_runs", {
  id: serial("id").primaryKey(),
  workflowId: integer("workflow_id").references(() => workflows.id, { onDelete: "set null" }),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  status: text("status").notNull().default("läuft"),
  report: text("report").notNull().default(""),
  counts: jsonb("counts").$type<RunCounts>().notNull().default({ added: 0, skipped: 0, updated: 0, templates: 0 }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, t => [index("workflow_runs_wf").on(t.workflowId, t.startedAt)]);

/* Reading one person's mailbox into the tenant's contacts: scan headers, then read signatures, then file them as leads.
   cursor is the source's own position (Graph next link, IMAP uid per folder) */
export type MailCursor = { next?: string; folders?: { path: string; sent: boolean; uid: number; max: number }[]; since?: string };

export const mailSyncs = pgTable("mail_syncs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  status: text("status").notNull().default("läuft"),
  phase: text("phase").notNull().default("scan"),
  cursor: jsonb("cursor").$type<MailCursor>().notNull().default({}),
  scanned: integer("scanned").notNull().default(0),
  imported: integer("imported").notNull().default(0),
  error: text("error").notNull().default(""),
  /* newest mail seen; the next run only reads mail after it */
  lastMailAt: timestamp("last_mail_at", { withTimezone: true }),
  /* one step at a time, whether the page or the cron drives it */
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, t => [uniqueIndex("mail_syncs_key").on(t.tenantId, t.userId)]);

/* What a signature says about its sender */
export type SigData = { salutation: string; first: string; last: string; role: string; company: string; phone: string; mobile: string; website: string; linkedin: string; street: string; city: string };

/* Everyone the mailbox exchanged mail with. state: offen (signature not read yet), gelesen, fertig (filed as lead), aus (not a contact) */
export const mailContacts = pgTable("mail_contacts", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  name: text("name").notNull().default(""),
  sent: integer("sent").notNull().default(0),
  received: integer("received").notNull().default(0),
  /* received mails addressed to the person directly, not bulk */
  direct: integer("direct").notNull().default(0),
  firstAt: timestamp("first_at", { withTimezone: true }),
  lastAt: timestamp("last_at", { withTimezone: true }),
  signature: text("signature").notNull().default(""),
  parsed: jsonb("parsed").$type<SigData | null>(),
  leadId: integer("lead_id").references(() => leads.id, { onDelete: "set null" }),
  state: text("state").notNull().default("offen"),
}, t => [uniqueIndex("mail_contacts_key").on(t.tenantId, t.userId, t.email), index("mail_contacts_state").on(t.tenantId, t.userId, t.state)]);

/* Mail sequence for people who registered on the website (synced to HubSpot). Each step is sent `day` days
   after registration; a reply pauses the person until someone decides to continue or stop. */
export type SeqStep = { day: number; name: string };
export type SeqMatch = { property: string; value: string };
export type SeqConfig = { enter: SeqMatch; bought: SeqMatch; stop: SeqMatch; senderId: number | null; trialDays: number; since: string };

export const sequences = pgTable("sequences", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(false),
  steps: jsonb("steps").$type<SeqStep[]>().notNull(),
  config: jsonb("config").$type<SeqConfig>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* Variants A/B/C of one step */
export const sequenceTemplates = pgTable("sequence_templates", {
  id: serial("id").primaryKey(),
  sequenceId: integer("sequence_id").notNull().references(() => sequences.id, { onDelete: "cascade" }),
  step: integer("step").notNull(),
  key: text("key").notNull(),
  tone: text("tone").notNull().default("sie"),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  active: boolean("active").notNull().default(true),
  score: jsonb("score").$type<MailScore>(),
}, t => [uniqueIndex("sequence_templates_key").on(t.sequenceId, t.step, t.key)]);

/* One person in a sequence. step = index of the next mail; status aktiv | antwort | beendet | gekauft | abgemeldet | unzustellbar */
export const enrollments = pgTable("enrollments", {
  id: serial("id").primaryKey(),
  sequenceId: integer("sequence_id").notNull().references(() => sequences.id, { onDelete: "cascade" }),
  hubspotId: text("hubspot_id").notNull(),
  email: text("email").notNull(),
  first: text("first").notNull().default(""),
  last: text("last").notNull().default(""),
  salutation: text("salutation").notNull().default(""),
  company: text("company").notNull().default(""),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  step: integer("step").notNull().default(0),
  status: text("status").notNull().default("aktiv"),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  repliedAt: timestamp("replied_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("enrollments_key").on(t.sequenceId, t.hubspotId), index("enrollments_status").on(t.sequenceId, t.status)]);

export const sequenceMails = pgTable("sequence_mails", {
  id: serial("id").primaryKey(),
  sequenceId: integer("sequence_id").notNull().references(() => sequences.id, { onDelete: "cascade" }),
  enrollmentId: integer("enrollment_id").notNull().references(() => enrollments.id, { onDelete: "cascade" }),
  step: integer("step").notNull(),
  variant: text("variant").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  senderId: integer("sender_id").references(() => users.id),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  repliedAt: timestamp("replied_at", { withTimezone: true }),
  bouncedAt: timestamp("bounced_at", { withTimezone: true }),
}, t => [index("sequence_mails_step").on(t.sequenceId, t.step)]);

/* An enrich run in the background: workers claim items by bumping next, so it survives tenant switches, reloads and closed tabs */
export type EnrichItem = { id: number; name: string };
export type EnrichJobResult = EnrichItem & { found: Partial<Record<"salutation" | "first" | "last" | "role" | "email" | "phone" | "linkedin" | "website" | "city", string>>; missed: EnrichField[]; error?: string };
export const enrichJobs = pgTable("enrich_jobs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  items: jsonb("items").$type<EnrichItem[]>().notNull(),
  fields: jsonb("fields").$type<EnrichField[]>().notNull(),
  again: boolean("again").notNull().default(false),
  skipped: integer("skipped").notNull().default(0),
  next: integer("next").notNull().default(0),
  done: integer("done").notNull().default(0),
  results: jsonb("results").$type<EnrichJobResult[]>().notNull().default([]),
  /* laeuft | fertig | gestoppt | fehler */
  status: text("status").notNull().default("laeuft"),
  error: text("error").notNull().default(""),
  seenAt: timestamp("seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("enrich_jobs_tenant").on(t.tenantId, t.id)]);

/* What the AI cost per action, as the provider reported it (OpenRouter usage.cost); one row per tracked call of an action,
   rows with the same ref belong to one action that ran over several function calls (an enrich job). Costs in millionths of a dollar. */
export const aiUsage = pgTable("ai_usage", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  kind: text("kind").notNull(),
  ref: text("ref"),
  items: integer("items").notNull().default(0),
  calls: integer("calls").notNull().default(0),
  /* calls whose provider reported no cost (Claude API) */
  unpriced: integer("unpriced").notNull().default(0),
  cost: bigint("cost_micro", { mode: "number" }).notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("ai_usage_tenant").on(t.tenantId, t.createdAt)]);
