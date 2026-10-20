import { and, asc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, leads, messages, tenants } from "@/db";
import { HttpError, checkEmail } from "./api";
import { toolChat, type ChatKey, type Tool, type ToolMsg } from "./ai";
import { attachCompanies } from "./companies";
import { berlinDate } from "./dates";
import { cleanLead, emailTypeOf, LEAD_FIELDS } from "./lead-fields";
import { channelOf, domain } from "./lead-rating";
import { setLeadStatus } from "./outreach";
import { bouncedDomains, liQueue, mailQueue, perDay, sendDates, setQueue } from "./queue";
import { later, refreshRatings } from "./ratings";
import { DAY_NAMES, daysText, isoWeekday, planOf } from "./schedule";

type Tenant = typeof tenants.$inferSelect;
export type ChatMsg = { role: "user" | "assistant"; content: string };

const STATUS = ["neu", "angeschrieben", "beantwortet", "unzustellbar", "dublette", "kontakt", "papierkorb"] as const;
const s = () => z.string().optional();
const Edit = z.object({
  id: z.number().int(), status: z.enum(STATUS).optional(), channel: z.enum(["", "mail", "linkedin"]).optional(), vote: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
  ...Object.fromEntries(LEAD_FIELDS.map(k => [k, s()])) as Record<typeof LEAD_FIELDS[number], ReturnType<typeof s>>,
});

const cut = (v: string, n: number) => v.replace(/[\n;]+/g, " ").trim().slice(0, n);
const placeKey = (v: string) => v.trim().toLowerCase();
const dm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
const day = (iso: string) => `${DAY_NAMES[isoWeekday(iso) - 1]} ${dm(iso)}`;
const nums = (v: unknown) => Array.isArray(v) ? v.map(Number).filter(Number.isSafeInteger) : [];
const strs = (v: unknown) => Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : [];

/* Open leads from the given places (Ort exactly as in the list), best first */
async function fromPlaces(tenantId: number, places: string[]) {
  const want = new Set(places.map(placeKey).filter(Boolean));
  if (!want.size) return [];
  const rows = await db.select({ id: leads.id, city: leads.city, rank: leads.queueRank }).from(leads)
    .where(and(eq(leads.tenantId, tenantId), eq(leads.status, "neu"), sql`${leads.sendpilotAt} is null`))
    .orderBy(sql`${leads.rating} desc nulls last`, asc(leads.createdAt), asc(leads.id));
  return rows.filter(r => want.has(placeKey(r.city)));
}

/* Leads found after the chat set settings.firstPlaces: open ones from those places without a place in the queue join the front,
   behind the last lead from those places. Runs before each evening run */
export async function rankFirst(t: Tenant) {
  const places = t.settings.firstPlaces ?? [];
  const fresh = (await fromPlaces(t.id, places)).filter(r => r.rank === null);
  if (!fresh.length) return 0;
  const want = new Set(places.map(placeKey));
  const ranked = await db.select({ id: leads.id, city: leads.city }).from(leads).where(and(eq(leads.tenantId, t.id), isNotNull(leads.queueRank))).orderBy(asc(leads.queueRank));
  const ids = ranked.map(r => r.id);
  ids.splice(ranked.findLastIndex(r => want.has(placeKey(r.city))) + 1, 0, ...fresh.map(r => r.id));
  await setQueue(t.id, ids);
  return fresh.length;
}

/* What the chat reads of the list: one query per table, only the columns it shows, read again after each change */
async function snapshot(t: Tenant) {
  const [rows, bounced, queue, li, drafts] = await Promise.all([
    db.select({ id: leads.id, company: leads.company, first: leads.first, last: leads.last, role: leads.role, city: leads.city, website: leads.website, email: leads.email,
      emailType: leads.emailType, linkedin: leads.linkedin, channel: leads.channel, status: leads.status, rating: leads.rating, sendpilotAt: leads.sendpilotAt, note: leads.note })
      .from(leads).where(and(eq(leads.tenantId, t.id), ne(leads.status, "papierkorb"))),
    bouncedDomains(t.id), mailQueue(t), liQueue(t),
    db.select({ id: messages.id, leadId: messages.leadId, leadIds: messages.leadIds, rank: messages.sendRank, status: messages.status }).from(messages)
      .where(and(eq(messages.tenantId, t.id), inArray(messages.status, ["entwurf", "freigegeben"]))).orderBy(asc(messages.id)),
  ]);
  const days = await sendDates(t, queue, li), pos = new Map(queue.map((q, i) => [q.id, i + 1]));
  const draft = new Map<number, (typeof drafts)[number]>();
  for (const m of drafts) for (const id of m.leadIds?.length ? m.leadIds : [m.leadId]) draft.set(id, m);
  rows.sort((a, b) => (days[a.id] || "9").localeCompare(days[b.id] || "9") || (pos.get(a.id) ?? Infinity) - (pos.get(b.id) ?? Infinity) || (b.rating ?? -1) - (a.rating ?? -1));
  const ch = (r: (typeof rows)[number]) => r.sendpilotAt ? "linkedin" : channelOf(r, bounced).ch;
  const label = (id: number) => { const m = draft.get(id); return !m ? "" : (m.rank ?? 0) < 0 ? "vorgezogen" : (m.rank ?? 0) > 0 ? "nach hinten" : m.status === "freigegeben" ? "freigegeben" : "wartet"; };
  const line = (r: (typeof rows)[number]) => [r.id, cut(r.company, 60), cut([r.first, r.last].filter(Boolean).join(" "), 40), cut(r.role, 40), cut(r.city, 40),
    r.website.replace(/^https?:\/\/(www\.)?/i, "").split("/")[0].toLowerCase() || domain(r.email), r.status, r.rating ?? "", ch(r), days[r.id] || "", pos.get(r.id) ?? "", label(r.id), cut(r.note, 80)].join(";");
  return { rows, byId: new Map(rows.map(r => [r.id, r])), days, pos, drafts, draft, line };
}
type Snap = Awaited<ReturnType<typeof snapshot>>;
const HEAD = "id;Firma;Person;Rolle;Ort;Domain;Status;Bewertung;Kanal;Versandtag;Platz;Entwurf;Notiz";

/* The situation the model starts from: send plan, places with counts and the next send days at a glance; details come through the tools */
function situation(t: Tenant, sn: Snap) {
  const st = new Map<string, number>(), places = new Map<string, { neu: number; freigabe: number }>(), byDay = new Map<string, Snap["rows"]>();
  for (const r of sn.rows) {
    st.set(r.status, (st.get(r.status) ?? 0) + 1);
    const c = r.city.trim();
    if (c && (r.status === "neu" || r.status === "freigabe")) { const p = places.get(c) ?? { neu: 0, freigabe: 0 }; p[r.status]++; places.set(c, p); }
    const d = sn.days[r.id];
    if (d) byDay.set(d, [...byDay.get(d) ?? [], r]);
  }
  const plan = [...byDay].sort(([a], [b]) => a.localeCompare(b)).slice(0, 8).map(([d, rs]) => {
    const towns = new Map<string, number>();
    for (const r of rs) towns.set(r.city.trim() || "ohne Ort", (towns.get(r.city.trim() || "ohne Ort") ?? 0) + 1);
    const f = rs.filter(r => r.status === "freigabe").length;
    return `- ${day(d)} (${d}): ${rs.length} Personen, ${f} mit Entwurf, ${rs.length - f} neu. Orte: ${[...towns].map(([c, k]) => `${c} ${k}`).join(", ")}`;
  });
  const p = planOf(t.settings);
  return `Heute ist ${day(berlinDate())} (${berlinDate()}). Mandant: ${t.name}.
Versand: ${daysText(p.days)}, ${p.from}–${p.to} Uhr, bis zu ${perDay(t)} Personen je Tag und Kanal.
Orte zuerst (gespeichert): ${t.settings.firstPlaces?.length ? t.settings.firstPlaces.join(", ") : "keine"}.
Leads je Status: ${[...st].map(([k, v]) => `${k} ${v}`).join(", ") || "keine"}.

Nächste Versandtage:
${plan.join("\n") || "- keine geplant"}

Orte der Leads mit Status neu oder freigabe (Schreibweise genau so verwenden; Anzahl neu/freigabe):
${[...places].sort((a, b) => b[1].neu + b[1].freigabe - a[1].neu - a[1].freigabe).map(([c, k]) => `${c} (${k.neu}/${k.freigabe})`).join(", ") || "keine"}`;
}

const SYSTEM = `Du bist der Assistent in der Lead-Liste von Sales Monster, einem Vertriebsportal für Kaltakquise im deutschen Mittelstand. Der Nutzer ordnet und pflegt hier seine Leads und plant, wer wann angeschrieben wird. Du führst seine Wünsche selbst aus, mit den Werkzeugen unten. Du bist kein Berater, der Vorschläge macht, sondern erledigst die Arbeit.

# Wie der Versand funktioniert
- Jeder Lead hat einen Status: neu (wartet in der Warteschlange), freigabe (ein Entwurf ist geschrieben und wartet auf Freigabe oder Versand), angeschrieben, beantwortet, unzustellbar, dublette, kontakt (bestehende Beziehung, wird nie kalt angeschrieben), papierkorb.
- Jeden Abend schreibt das Portal Entwürfe für die nächsten Leads der Warteschlange (Status neu → freigabe). Sie gehen am nächsten Versandtag raus, nachdem der Nutzer sie freigegeben hat.
- Je Versandtag und Kanal gehen höchstens so viele Personen raus wie im Tageslimit steht. Kontakte derselben Firma gehen am selben Tag raus.
- Versandtage werden so verteilt: zuerst alle wartenden Entwürfe (älteste zuerst, vorgezogene davor, nach hinten geschobene ganz ans Ende), danach die Warteschlange der Leads mit Status neu.
- Die Warteschlange (Status neu) ist so sortiert: zuerst Leads aus den gespeicherten Orten (die besten zuerst), dann einzeln gesetzte Leads, dann alle anderen nach Bewertung.
- Kanal: mail oder linkedin. LinkedIn-Leads laufen über eine SendPilot-Kampagne und haben eigene Tageskontingente.

# Werkzeuge
- leads_suchen: Leads finden, nach Text, Ort, Status, ids oder Versandtag. Nutze es, bevor du über bestimmte Leads sprichst oder sie änderst; rate nie ids.
- versandplan: wer an den nächsten Versandtagen angeschrieben wird, Tag für Tag.
- reihenfolge_setzen: legt fest, welche Leads mit Status neu zuerst drankommen (Orte und/oder einzelne ids). Ersetzt die bisherige Reihenfolge vollständig; willst du etwas ergänzen, gib die bisherigen Orte mit.
- entwuerfe_verschieben: verschiebt wartende Entwürfe (Leads mit Status freigabe) auf frühere oder spätere Versandtage: "vor" zieht sie vor alle anderen Entwürfe, "nach_hinten" schiebt sie hinter alle anderen Entwürfe und hinter die Leads, die neu nachkommen, "normal" hebt das auf.
- leads_aendern: Status, Kanal, Bewertung durch den Nutzer (vote) und Felder einzelner Leads ändern. Setzt du einen Lead mit Status freigabe auf neu, wird sein Entwurf verworfen und er geht zurück in die Warteschlange; das gilt auch für Kollegen auf demselben Entwurf.

# So gehst du vor
1. Verstehe den Wunsch. Ist er klar, führe ihn sofort aus, ohne Rückfrage und ohne Zwischenbericht. Frag nur nach, wenn er wirklich mehrdeutig ist oder du mehr als 20 Leads in den Papierkorb legen oder auf neu zurücksetzen würdest, ohne dass der Nutzer das ausdrücklich gesagt hat.
2. Hole dir die nötigen Daten (leads_suchen, versandplan), führe die Änderung aus und prüfe danach mit versandplan oder leads_suchen, ob das Ergebnis dem Wunsch entspricht. Wenn nicht, korrigiere es.
3. Wünsche zu bestimmten Tagen ("Mittwoch nur Frankfurt"): Entwürfe passender Leads mit entwuerfe_verschieben "vor" holen, unpassende Entwürfe dieser Tage "nach_hinten" schieben, und die passenden Leads mit Status neu per reihenfolge_setzen nach vorn stellen. Freie Plätze an diesen Tagen füllt der Abendlauf dann mit den vordersten Leads der Warteschlange. Sag dazu, dass deren Entwürfe am Abend davor entstehen und noch freigegeben werden müssen.
4. Regionen und Landkreise löst du mit deinem Wissen über Geografie in Orte auf, z. B. Main-Taunus-Kreis: Hofheim am Taunus, Hattersheim, Flörsheim, Hochheim, Kriftel, Eppstein, Kelkheim, Bad Soden, Eschborn, Schwalbach, Sulzbach, Liederbach. Rhein-Main: Frankfurt, Offenbach, Wiesbaden, Darmstadt, Hanau, Bad Homburg, Oberursel und die umliegenden Kreise. Nimm die Orte genau so, wie sie in der Ortsliste stehen (z. B. "Frankfurt am Main"). Leads ohne Ort ordnest du über Domain, Firmenname oder Notiz zu, wenn es eindeutig ist.
5. Bei Fragen ("wer geht Mittwoch raus?") nur lesen, nichts ändern.
6. Erfinde keine Kontaktdaten und keine Fakten. Was ein Werkzeug nicht liefert, weißt du nicht.

# Antwort
- Deutsch, du-Form, knapp und sachlich, ohne Floskeln, ohne Einleitung wie "Gerne" und ohne Angebote am Ende.
- Schreib erst, wenn du fertig bist; kein Text vor oder zwischen Werkzeugaufrufen.
- Sag, was du geändert hast und was daraus folgt (welche Tage, welche Orte, wie viele Leads), mit den Zahlen aus den Werkzeugen, nicht geschätzt. Nenne Leads mit Firma und Ort, ids nur, wenn der Nutzer danach fragt.
- Konnte etwas nicht umgesetzt werden, sag klar, was und warum, und was stattdessen passiert ist.
- Markdown ist erlaubt. Listen höchstens zehn Einträge, den Rest zusammenfassen.`;

const PARAMS = {
  leads_suchen: { type: "object", properties: {
    suche: { type: "string", description: "Text in Firma, Person, Rolle, Domain, E-Mail oder Notiz" },
    orte: { type: "array", items: { type: "string" }, description: "Orte; trifft auch Orte, die den Text enthalten" },
    status: { type: "array", items: { type: "string", enum: ["neu", "freigabe", "angeschrieben", "beantwortet", "unzustellbar", "dublette", "kontakt"] } },
    ids: { type: "array", items: { type: "integer" } },
    versandtag_von: { type: "string", description: "YYYY-MM-DD" }, versandtag_bis: { type: "string", description: "YYYY-MM-DD" },
    limit: { type: "integer", description: "höchstens so viele Zeilen, Standard 100, maximal 400" },
  } },
  versandplan: { type: "object", properties: { tage: { type: "integer", description: "Anzahl Versandtage ab heute, Standard 5, maximal 15" } } },
  reihenfolge_setzen: { type: "object", properties: {
    orte: { type: "array", items: { type: "string" }, description: "Orte aus der Ortsliste, deren Leads mit Status neu zuerst drankommen" },
    ids: { type: "array", items: { type: "integer" }, description: "einzelne Leads mit Status neu in gewünschter Reihenfolge, nach den Orten" },
    zuruecksetzen: { type: "boolean", description: "true hebt jede gesetzte Reihenfolge auf; dann gilt nur die Bewertung" },
  } },
  entwuerfe_verschieben: { type: "object", required: ["ids", "wohin"], properties: {
    ids: { type: "array", items: { type: "integer" }, description: "Lead-ids mit Status freigabe, bei vor in gewünschter Reihenfolge" },
    wohin: { type: "string", enum: ["vor", "nach_hinten", "normal"] },
  } },
  leads_aendern: { type: "object", required: ["aenderungen"], properties: { aenderungen: { type: "array", items: { type: "object", required: ["id"], properties: {
    id: { type: "integer" }, status: { type: "string", enum: [...STATUS] }, channel: { type: "string", enum: ["", "mail", "linkedin"], description: "\"\" = Empfehlung des Portals" },
    vote: { type: "integer", enum: [-1, 0, 1], description: "1 guter Lead, -1 schlechter, 0 neutral" },
    ...Object.fromEntries(LEAD_FIELDS.map(k => [k, { type: "string" }])),
  } } } } },
};

/* Field edits as the lead dialog makes them: address checks first, so a bad address changes nothing. A lead leaving freigabe drops its draft
   as "Überspringen" in Freigabe does, and the other people on that draft go back to the queue */
async function applyEdits(tenantId: number, edits: z.infer<typeof Edit>[], sn: Snap) {
  const found = new Map((await db.select().from(leads).where(and(eq(leads.tenantId, tenantId), inArray(leads.id, edits.map(e => e.id))))).map(l => [l.id, l]));
  const todo = edits.filter(e => found.has(e.id));
  for (const e of todo) { const v = cleanLead(e), l = found.get(e.id)!; if (v.email && v.email.toLowerCase() !== l.email.toLowerCase()) await checkEmail(tenantId, v.email, e.id); }
  const drop = [...new Set(todo.filter(e => e.status && found.get(e.id)!.status === "freigabe" && sn.draft.has(e.id)).map(e => sn.draft.get(e.id)!))];
  if (drop.length) {
    await db.update(messages).set({ status: "uebersprungen" }).where(inArray(messages.id, drop.map(m => m.id)));
    await db.update(leads).set({ status: "neu" }).where(and(eq(leads.tenantId, tenantId), eq(leads.status, "freigabe"), inArray(leads.id, drop.flatMap(m => m.leadIds?.length ? m.leadIds : [m.leadId]))));
  }
  let moved = false;
  for (const { id, status, channel, vote, ...f } of todo) {
    const l = found.get(id)!, v: Partial<typeof leads.$inferInsert> = cleanLead(f);
    if (v.company === "") delete v.company;
    if (v.email !== undefined || v.first !== undefined || v.last !== undefined) v.emailType = emailTypeOf(v.email ?? l.email, !!((v.first ?? l.first) || (v.last ?? l.last)));
    if (v.company !== undefined && v.company !== l.company) { v.companyId = null; moved = true; }
    if (channel !== undefined) v.channel = channel;
    if (vote !== undefined) v.vote = vote;
    if (Object.keys(v).length) await db.update(leads).set(v).where(eq(leads.id, id));
    if (status && status !== l.status) await setLeadStatus(tenantId, id, status);
  }
  if (moved) await attachCompanies(tenantId);
  return { ids: todo.map(e => e.id), dropped: drop.length };
}

/* The chat under the lead list: a cheap fast model with tools reads what it needs, changes order, drafts and leads, and streams its answer */
export async function leadChat(ai: ChatKey, tenant: Tenant, history: ChatMsg[], signal?: AbortSignal, onText?: (text: string) => void) {
  let t = tenant, snap: Promise<Snap> | null = null;
  const sn = () => snap ??= snapshot(t), fresh = () => { snap = null; return sn(); };
  const touched = new Set<number>();
  let reordered = false;

  /* lines of the given leads, grouped by send day */
  const plan = (s: Snap, ids: number[]) => {
    const g = new Map<string, number>();
    for (const id of ids) { const d = s.days[id] || "ohne Versandtag"; g.set(d, (g.get(d) ?? 0) + 1); }
    return [...g].sort(([a], [b]) => a.localeCompare(b)).map(([d, k]) => `${d === "ohne Versandtag" ? d : day(d)}: ${k}`).join(", ");
  };

  const tools: Tool[] = [
    { name: "leads_suchen", description: "Leads der Liste suchen (ohne Papierkorb), sortiert nach Versandtag und Platz. Liefert CSV mit Semikolon.", parameters: PARAMS.leads_suchen, run: async a => {
      const s = await sn(), q = String(a.suche ?? "").trim().toLowerCase(), orte = strs(a.orte).map(placeKey), st = strs(a.status), ids = new Set(nums(a.ids));
      const von = String(a.versandtag_von ?? ""), bis = String(a.versandtag_bis ?? ""), limit = Math.max(1, Math.min(400, Number(a.limit) || 100));
      const hit = s.rows.filter(r => (!ids.size || ids.has(r.id)) && (!st.length || st.includes(r.status))
        && (!orte.length || orte.some(o => placeKey(r.city) === o || placeKey(r.city).includes(o)))
        && (!q || [r.company, r.first, r.last, r.role, r.website, r.email, r.note].join(" ").toLowerCase().includes(q))
        && (!von || (s.days[r.id] ?? "") >= von) && (!bis || (!!s.days[r.id] && s.days[r.id] <= bis)));
      return `${hit.length} Treffer${hit.length > limit ? `, die ersten ${limit}` : ""}\n${HEAD}\n${hit.slice(0, limit).map(s.line).join("\n")}`;
    } },
    { name: "versandplan", description: "Wer an den nächsten Versandtagen angeschrieben wird, je Tag alle Leads als CSV.", parameters: PARAMS.versandplan, run: async a => {
      const s = await sn(), k = Math.max(1, Math.min(15, Number(a.tage) || 5));
      const ds = [...new Set(Object.values(s.days))].sort().slice(0, k);
      return ds.map(d => { const rs = s.rows.filter(r => s.days[r.id] === d); return `## ${day(d)} (${d}), ${rs.length} Personen\n${HEAD}\n${rs.map(s.line).join("\n")}`; }).join("\n\n") || "Keine Versandtage geplant.";
    } },
    { name: "reihenfolge_setzen", description: "Setzt, welche Leads mit Status neu zuerst angeschrieben werden. Ersetzt die bisherige Reihenfolge.", parameters: PARAMS.reihenfolge_setzen, run: async a => {
      const s = await sn(), reset = a.zuruecksetzen === true, places = reset ? [] : strs(a.orte);
      const front = await fromPlaces(t.id, places), known = new Set(front.map(r => placeKey(r.city)));
      const ids = [...new Set([...front.map(r => r.id), ...(reset ? [] : nums(a.ids)).filter(id => s.byId.get(id)?.status === "neu")])].slice(0, 2000);
      await setQueue(t.id, ids);
      await db.update(tenants).set({ settings: sql`${tenants.settings} || ${JSON.stringify({ firstPlaces: places })}::jsonb` }).where(eq(tenants.id, t.id));
      t = { ...t, settings: { ...t.settings, firstPlaces: places } };
      reordered = true; for (const id of ids) touched.add(id);
      const after = await fresh(), mail = ids.filter(id => after.pos.has(id)).length;
      return { vorn: ids.length, per_mail: mail, per_linkedin_oder_ohne_tag: ids.length - mail, versandtage_dieser_leads: plan(after, ids),
        orte_ohne_leads_mit_status_neu: places.filter(p => !known.has(placeKey(p))) };
    } },
    { name: "entwuerfe_verschieben", description: "Wartende Entwürfe (Leads mit Status freigabe) auf frühere oder spätere Versandtage verschieben.", parameters: PARAMS.entwuerfe_verschieben, run: async a => {
      const s = await sn(), want = nums(a.ids), wohin = String(a.wohin);
      if (!["vor", "nach_hinten", "normal"].includes(wohin)) throw new Error("wohin muss vor, nach_hinten oder normal sein");
      const ms = [...new Set(want.map(id => s.draft.get(id)).filter(m => !!m))];
      if (!ms.length) return { fehler: "Keiner dieser Leads hat einen wartenden Entwurf. Leads mit Status neu ordnest du mit reihenfolge_setzen." };
      const mine = new Set(ms.map(m => m.id));
      /* earlier moves keep their place, this one joins behind them */
      const keep = (side: number) => s.drafts.filter(m => !mine.has(m.id) && Math.sign(m.rank ?? 0) === side).sort((x, y) => (x.rank ?? 0) - (y.rank ?? 0) || x.id - y.id);
      const set = (list: typeof ms, rank: (i: number) => number | null) => Promise.all(list.map((m, i) => db.update(messages).set({ sendRank: rank(i) }).where(eq(messages.id, m.id))));
      if (wohin === "vor") { const all = [...keep(-1), ...ms]; await set(all, i => i - all.length); }
      else if (wohin === "nach_hinten") { const all = [...keep(1), ...ms]; await set(all, i => i + 1); }
      else await set(ms, () => null);
      reordered = true;
      const ids = ms.flatMap(m => m.leadIds?.length ? m.leadIds : [m.leadId]);
      for (const id of ids) touched.add(id);
      const after = await fresh();
      return { verschoben: ms.length, personen: ids.length, ohne_entwurf: want.filter(id => !s.draft.has(id)), versandtage_jetzt: plan(after, ids) };
    } },
    { name: "leads_aendern", description: "Status, Kanal, vote und Felder einzelner Leads ändern. Nur geänderte Felder angeben.", parameters: PARAMS.leads_aendern, run: async a => {
      const s = await sn(), edits = z.array(Edit).max(500).parse(a.aenderungen).filter(e => s.byId.has(e.id));
      if (!edits.length) return { fehler: "Keine dieser ids ist in der Liste" };
      const r = await applyEdits(t.id, edits, s).catch(e => { if (e instanceof HttpError) return { fehler: e.message }; throw e; });
      if ("fehler" in r) return r;
      for (const id of r.ids) touched.add(id);
      if (r.dropped) reordered = true;
      if (r.ids.length) await later(() => refreshRatings(t.id, r.ids));
      const after = await fresh();
      return { geaendert: r.ids.length, entwuerfe_verworfen: r.dropped, jetzt: r.ids.slice(0, 50).map(id => after.byId.get(id)).filter(x => !!x).map(after.line) };
    } },
  ];

  const msgs: ToolMsg[] = [
    { role: "system", content: SYSTEM },
    { role: "system", content: situation(t, await sn()) },
    ...history.slice(-12).map(m => ({ role: m.role, content: m.content })),
  ];
  const reply = await toolChat(ai, msgs, tools, signal, onText);
  /* ids = leads the answer changed or moved, so the list can show them; reordered = the send order is new */
  return { reply: reply || "Erledigt.", changed: touched.size || (reordered ? 1 : 0), ids: [...touched], reordered };
}
