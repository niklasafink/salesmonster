/* npx tsx scripts/add-profiles.ts [--dry]  — lead profiles: table and columns (only adds, safe to run again), a default profile for every
   tenant, and for Conformis GRC the default "Conformis allgemein" plus "Bekri". Existing leads and templates keep profile_id null = default. */
import { config } from "dotenv";
config({ path: process.env.ENV_FILE || ".env.local" });

const DDL = [
  `create table if not exists profiles (id serial primary key, tenant_id integer not null references tenants(id) on delete cascade, name text not null,
     audience text not null default '', is_default boolean not null default false, created_at timestamptz not null default now())`,
  `create unique index if not exists profiles_name on profiles (tenant_id, name)`,
  `create unique index if not exists profiles_default on profiles (tenant_id) where is_default`,
  `alter table leads add column if not exists profile_id integer references profiles(id) on delete set null`,
  `alter table templates add column if not exists profile_id integer references profiles(id) on delete set null`,
  `create index if not exists leads_profile on leads (tenant_id, profile_id)`,
];

const BEKRI = `Bekri (Berichtskritik): Einzel-WPs und kleine WPGs mit höchstens 3 WPs, je kleiner desto besser; keine Big Four, keine Next Ten.
Ansprechpartner: Inhaber, Partner oder Geschäftsführer, die selbst Abschlussprüfungen durchführen (§ 316 HGB, im WPK-Register angezeigt).
Angebot: Berichtskritik, also die kritische Durchsicht von Prüfungsberichten vor der Auslieferung.`;

async function main() {
  const dry = process.argv.includes("--dry");
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!);
  console.log(`Datenbank: ${new URL(process.env.DATABASE_URL!).host}${dry ? " (nur anzeigen)" : ""}`);
  for (const q of DDL) { console.log(q.split("\n")[0].slice(0, 90)); if (!dry) await sql.query(q); }
  if (dry) return;
  const ts = await sql.query(`select id, slug, name from tenants order by id`) as { id: number; slug: string; name: string }[];
  for (const t of ts) {
    const def = t.slug === "conformis-grc" ? "Conformis allgemein" : "Allgemein";
    await sql.query(`insert into profiles (tenant_id, name, is_default) select $1, $2, true where not exists (select 1 from profiles where tenant_id = $1 and is_default)`, [t.id, def]);
    if (t.slug === "conformis-grc")
      await sql.query(`insert into profiles (tenant_id, name, audience) values ($1, 'Bekri', $2) on conflict (tenant_id, name) do nothing`, [t.id, BEKRI]);
    const ps = await sql.query(`select name, is_default from profiles where tenant_id = $1 order by id`, [t.id]) as { name: string; is_default: boolean }[];
    const [{ n }] = await sql.query(`select count(*)::int n from leads where tenant_id = $1 and profile_id is null`, [t.id]) as { n: number }[];
    console.log(`${t.slug}: ${ps.map(p => p.name + (p.is_default ? " (Standard)" : "")).join(", ")}; ${n} Leads im Standardprofil`);
  }
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
