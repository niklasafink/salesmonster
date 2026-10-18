import type { InvoiceSettings, TenantSettings, Tender } from "@/db/schema";

export type Person = { id: number; name: string; short: string; email: string; phone: string };
export type Tpl = { id: number; key: string; name: string; tone: string; subject: string; body: string; active: boolean; sent: number; replies: number; bounced: number; total: number | null; expected: number; improved: { sent: number; replies: number } };
export type DraftLead = { id: number; company: string; city: string; first: string; last: string; salutation: string; role: string; email: string; emailType: string;
  linkedin: string; hook: string; tenders: Tender[]; source: string; website: string; sourceUrl: string };
export type DraftPerson = { first: string; last: string; salutation: string; role: string; email: string };
export type DraftScore = { total: number; issues: string[]; expected?: number };
export type Draft = { score: DraftScore | null; improved: boolean; id: number; batchDate: string; variant: string; channel: string; subject: string | null; body: string | null; status: string; error: string; senderId: number | null; lead: DraftLead; to: string; people: DraftPerson[] };
export type Run = { id: number; kind: string; ok: boolean; info: string; createdAt: string };
export type TenantInfo = { slug: string; name: string; initials: string; domain: string; tenders: boolean; settings: TenantSettings; invoice: InvoiceSettings | null };

export type State = {
  me: Person; users: Person[]; tenants: { slug: string; name: string; initials: string }[];
  tenant: TenantInfo | null; templates: Tpl[]; drafts: Draft[];
  integ: Record<string, { on: boolean; detail: string }>; msConfigured: boolean; mailbox: Record<number, string | null>; runs: Run[];
  setup: { step: string; done: boolean; started: boolean };
  ai: { options: { id: string; label: string }[]; current: string | null };
  mailSync: MailSync | null;
};

export type MailSync = { status: string; phase: string; scanned: number; contacts: number; imported: number; error: string; finishedAt: string | null };

/* a download action, or an error (stays longer, no check mark) */
export type ToastOpt = { label: string; href: string } | { error: true };

export type Ctx = {
  st: State; reload: () => Promise<void>; toast: (m: string, opt?: ToastOpt) => void;
  setView: (v: string) => void; openSidebar: () => void;
};
