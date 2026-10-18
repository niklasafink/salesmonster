/* npx tsx scripts/prefill.ts <file.json>  — fills a tenant from a research file kept outside the repo:
   { slug, prompt?, templates?: [{key,name,tone,subject,body,active?}], setup?: {profile,segments,personas}, leads?: [...] }
   Leads go in as "neu"; people already in the tenant are skipped. */
import { readFileSync } from "node:fs";
import { config } from "dotenv";
config({ path: ".env.local" });

type In = { company: string; city?: string; website?: string; first?: string; last?: string; salutation?: string; role?: string; email?: string; emailType?: string; linkedin?: string; hook?: string; note?: string; source?: string; sourceUrl?: string; research?: string };

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Datei fehlt");
  const data = JSON.parse(readFileSync(file, "utf8"));
  const { db, tenants, templates, leads, setups } = await import("../src/db");
  const { and, eq } = await import("drizzle-orm");
  const { attachCompanies } = await import("../src/lib/companies");
  const { salutationOf } = await import("../src/lib/lead-fields");
  const [t] = await db.select().from(tenants).where(eq(tenants.slug, data.slug));
  if (!t) throw new Error(`Mandant ${data.slug} fehlt`);

  if (data.prompt) await db.update(tenants).set({ settings: { ...t.settings, prompt: data.prompt } }).where(eq(tenants.id, t.id));

  for (const x of data.templates ?? []) {
    const v = { name: x.name, tone: x.tone, subject: x.subject, body: x.body, active: x.active ?? true, origin: "Recherche", score: null };
    await db.insert(templates).values({ tenantId: t.id, key: x.key, ...v }).onConflictDoUpdate({ target: [templates.tenantId, templates.key], set: v });
  }

  if (data.setup) {
    const v = { profile: data.setup.profile, segments: data.setup.segments, personas: data.setup.personas, sources: { website: "recherche" as const, zielgruppe: "recherche" as const, ansprechpartner: "recherche" as const, fertig: "recherche" as const }, step: "fertig" as const, doneAt: new Date(), updatedAt: new Date() };
    const [cur] = await db.select({ id: setups.id }).from(setups).where(and(eq(setups.tenantId, t.id), eq(setups.active, true)));
    if (cur) await db.update(setups).set(v).where(eq(setups.id, cur.id)); else await db.insert(setups).values({ tenantId: t.id, ...v });
  }

  /* one row per person; several people at one company end up in one company */
  const who = (c: string, f: string, l: string) => `${c}|${f}|${l}`.toLowerCase();
  const known = new Set((await db.select({ c: leads.company, f: leads.first, l: leads.last }).from(leads).where(eq(leads.tenantId, t.id))).map(r => who(r.c, r.f, r.l)));
  let n = 0;
  for (const l of (data.leads ?? []) as In[]) {
    const key = who(l.company, l.first || "", l.last || "");
    if (!l.company || known.has(key)) continue;
    known.add(key);
    await db.insert(leads).values({ tenantId: t.id, company: l.company, city: l.city || "", website: l.website || "", first: l.first || "", last: l.last || "", salutation: salutationOf(l.salutation || ""),
      role: l.role || "", email: l.email || "", emailType: l.emailType === "info" ? "info" : "person", linkedin: l.linkedin || "", hook: l.hook || "",
      note: (l.note || "").slice(0, 500), source: l.source || "Recherche", sourceUrl: l.sourceUrl || "", research: l.research || "", status: "neu" });
    n++;
  }
  await attachCompanies(t.id);
  console.log(`${t.name}: ${data.prompt ? "Prompt, " : ""}${(data.templates ?? []).length} Vorlagen, ${data.setup ? "Einrichtung, " : ""}${n} Leads`);
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
