/* npx tsx scripts/touches-dry.ts <tenant-slug> [n]
   Reads the HubSpot activities and lets Jev judge demo, call and personal mail for n contacts with activities; writes nothing. */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

async function main() {
  const [slug, n = "12"] = process.argv.slice(2);
  const { eq } = await import("drizzle-orm");
  const { db, tenants } = await import("../src/db");
  const { hubspotActivities, hubspotToken } = await import("../src/lib/hubspot");
  const { jevKey, judgeTouches } = await import("../src/lib/jev");
  const t = await import("../src/lib/touches");
  const [ten] = await db.select().from(tenants).where(eq(tenants.slug, slug));
  const token = await hubspotToken(ten.id), key = await jevKey(ten.id);
  if (!token || !key) throw new Error("HubSpot oder OpenRouter fehlt");
  const kinds = { calls: ["hs_timestamp", "hs_call_title", "hs_call_body", "hs_call_status"], meetings: ["hs_timestamp", "hs_meeting_title", "hs_meeting_body", "hs_meeting_outcome"],
    notes: ["hs_timestamp", "hs_note_body"], emails: ["hs_timestamp", "hs_email_subject", "hs_email_text", "hs_email_direction"] } as const;
  const props = { calls: ["hs_call_title", "hs_call_body", "hs_call_status"], meetings: ["hs_meeting_title", "hs_meeting_body", "hs_meeting_outcome"], notes: ["", "hs_note_body", ""], emails: ["hs_email_subject", "hs_email_text", "hs_email_direction"] } as const;
  const by = new Map<string, import("../src/lib/touches").Act[]>();
  for (const k of Object.keys(kinds) as (keyof typeof kinds)[]) {
    try {
      const list = await hubspotActivities(token, k, [...kinds[k]]);
      console.log(k, list.length);
      for (const x of list) for (const c of x.associations?.contacts?.results || []) {
        const [ti, bo, ex] = props[k], p = (f: string) => (f ? x.properties[f] : "") || "";
        by.set(c.id, [...(by.get(c.id) || []), { kind: k, at: Date.parse(p("hs_timestamp")) || 0, title: p(ti), body: p(bo), extra: p(ex) }]);
      }
    } catch (e) { console.log(k, "Fehler:", (e as Error).message); }
  }
  console.log("Kontakte mit Aktivitäten:", by.size);
  /* the ones with calls or meetings first, they are the interesting cases */
  const pick = [...by].sort((a, b) => Number(b[1].some(x => x.kind !== "emails")) - Number(a[1].some(x => x.kind !== "emails"))).slice(0, Number(n));
  const now = new Date();
  for (const [id, acts] of pick) {
    const text = t.activityText(acts, now), j = await judgeTouches(key, text);
    console.log(`\n#${id}  Demo ${j.demo}  Telefon ${j.call}  Mail ${j.mail}\n${text.split("\n").slice(0, 5).map(l => l.slice(0, 160)).join("\n")}`);
  }
}
main().then(() => process.exit(0), e => { console.error(e.message); process.exit(1); });
