/* npx tsx scripts/score-mails.ts mails.jsonl [out.jsonl]
   Scores a collection of cold mails with Jev and shows what goes with replies.
   One JSON object per line: {"subject":"…","body":"…","replied":true|false (optional),"source":"…" (optional)}
   Needs OPENROUTER_API_KEY in .env.local. Jev costs about 3 cents per 1,000 mails. */
import { config } from "dotenv";
config({ path: ".env.local" });
import { readFileSync, writeFileSync } from "node:fs";

type Row = { subject: string; body: string; replied?: boolean; source?: string };

async function main() {
  const [file, outFile] = process.argv.slice(2);
  const key = process.env.OPENROUTER_API_KEY;
  if (!file) throw new Error("Datei fehlt: npx tsx scripts/score-mails.ts mails.jsonl");
  if (!key) throw new Error("OPENROUTER_API_KEY fehlt in .env.local");
  const { scoreMail } = await import("../src/lib/jev");

  const rows: Row[] = readFileSync(file, "utf8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
  const scored = [];
  for (const [i, r] of rows.entries()) {
    const s = await scoreMail(key, { subject: r.subject || "", body: r.body || "" });
    scored.push({ ...r, ...s });
    process.stdout.write(`\r${i + 1}/${rows.length}`);
  }
  console.log();
  if (outFile) writeFileSync(outFile, scored.map(x => JSON.stringify(x)).join("\n") + "\n");

  const mean = (xs: number[]) => xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : "–";
  console.log(`\n${scored.length} Mails · Jev-Antwortchance im Schnitt ${mean(scored.map(x => x.reply))} von 4`);

  const weak: Record<string, number> = {};
  for (const x of scored) weak[x.weakness] = (weak[x.weakness] || 0) + 1;
  console.log("Häufigste Schwäche:", Object.entries(weak).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · "));

  const labeled = scored.filter(x => typeof x.replied === "boolean");
  if (!labeled.length) return;
  const rate = (xs: typeof labeled) => xs.length ? `${(100 * xs.filter(x => x.replied).length / xs.length).toFixed(1)} % von ${xs.length}` : "–";
  const groups: [string, (x: (typeof labeled)[number]) => boolean][] = [
    ["unter 100 Wörter", x => x.words < 100], ["100 bis 200 Wörter", x => x.words >= 100 && x.words <= 200], ["über 200 Wörter", x => x.words > 200],
    ["Betreff unter 30 Zeichen", x => x.subjectLen < 30], ["Betreff ab 30 Zeichen", x => x.subjectLen >= 30],
    ["Jev 3 bis 4", x => x.reply >= 3], ["Jev 2 bis 3", x => x.reply >= 2 && x.reply < 3], ["Jev unter 2", x => x.reply < 2],
    ["konkret laut Jev", x => x.specific >= 0.5], ["nicht konkret", x => x.specific < 0.5],
  ];
  console.log(`\nAntwortquote gesamt: ${rate(labeled)}`);
  for (const [name, f] of groups) console.log(`${name.padEnd(26)} ${rate(labeled.filter(f))}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
