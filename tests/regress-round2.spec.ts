import { expect, test, type APIRequestContext } from "@playwright/test";

/* Regressions from the second QA round: dialog focus, import and template checks, small UI fixes. Writes only to the QA tenant. */
const Q = "qa-testfirma";
type Lead = { id: number; company: string; first: string; email: string };
type Tpl = { id: number; key: string; subject: string; body: string; active: boolean; sent: number };
type State = { templates: Tpl[]; integ: Record<string, { on: boolean }> };

const state = async (request: APIRequestContext) => (await (await request.get(`/api/state?t=${Q}`)).json()) as State;
const leadsOf = async (request: APIRequestContext) => (await (await request.get(`/api/leads?t=${Q}`)).json()).rows as Lead[];
const noAi = async (request: APIRequestContext) => { const s = await state(request); return !s.integ.claude?.on && !s.integ.openrouter?.on; };
const strip = (s: string) => s.replace(/ QA-\d{13}/g, "");
async function cleanup(request: APIRequestContext, tag: string) {
  for (const l of await leadsOf(request)) if (l.company.includes(tag)) await request.delete(`/api/leads/${l.id}`);
}

test("Dialog: Fokus wandert hinein, bleibt drin und kehrt zurück", async ({ page }) => {
  await page.goto("/#leads");
  const open = page.getByRole("button", { name: "Kontakt", exact: true });
  await open.click();
  const dlg = page.getByRole("dialog", { name: "Kontakt hinzufügen" });
  await expect(dlg).toBeVisible();
  const inside = () => dlg.evaluate(el => el.contains(document.activeElement));
  await expect.poll(inside).toBe(true);
  for (let i = 0; i < 30; i++) { await page.keyboard.press("Tab"); expect(await inside(), `Tab ${i + 1}`).toBe(true); }
  for (let i = 0; i < 30; i++) { await page.keyboard.press("Shift+Tab"); expect(await inside(), `Shift+Tab ${i + 1}`).toBe(true); }
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(open).toBeFocused();
});

test("Import-Dialog: Fokus bleibt im Dialog", async ({ page }) => {
  await page.goto("/#leads");
  await page.getByRole("button", { name: "Importieren" }).click();
  const dlg = page.getByRole("dialog", { name: "Importieren" });
  await expect(dlg.getByPlaceholder("Liste, Tabelle oder Text einfügen")).toBeFocused();
  for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
  expect(await dlg.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
});

test("Import-Vorschau: ungültige E-Mail wird verworfen und markiert", async ({ request }) => {
  test.skip(!(await noAi(request)), "QA-Mandant hat eine KI verbunden");
  const tag = `QA-${Date.now()}`;
  const r = await request.post("/api/leads/parse", { data: { t: Q, text: `Firma,Vorname,Nachname,E-Mail\n${tag} DGH GmbH,Xaver,Ypsilon,kaputt@` } });
  expect(r.status()).toBe(200);
  const [row] = (await r.json()).rows as { co: string; email: string; dup: string; extra: string }[];
  expect(row.co).toContain(tag);
  expect(row.email).toBe("");
  expect(row.dup).toBe("");
  expect(row.extra).toBe("E-Mail ungültig");
});

test("Import: ungültige E-Mail wird nicht gespeichert", async ({ request }) => {
  const tag = `QA-${Date.now()}`;
  try {
    const r = await request.post("/api/leads", { data: { t: Q, source: tag, rows: [
      { co: `${tag} DGH GmbH`, p: "Xaver Ypsilon", role: "", email: "kaputt@", web: "", city: "" },
      { co: `${tag} Gut GmbH`, p: "Gerd Gut", role: "", email: `gerd.${tag.toLowerCase()}@example.com`, web: "", city: "" }] } });
    expect(r.status()).toBe(200);
    const mine = (await leadsOf(request)).filter(l => l.company.includes(tag));
    expect(mine.find(l => l.company.includes("DGH"))?.email).toBe("");
    expect(mine.find(l => l.company.includes("Gut"))?.email).toBe(`gerd.${tag.toLowerCase()}@example.com`);
  } finally {
    await cleanup(request, tag);
  }
});

test("Vorlage: kaputte und unbekannte Platzhalter werden abgelehnt", async ({ request }) => {
  /* not A, which vorlagen.spec edits */
  const ts = (await state(request)).templates, a = ts.find(x => x.key !== "A") || ts[0];
  const orig = { subject: strip(a.subject), body: a.body };
  try {
    for (const data of [{ subject: "Kurze Frage zu {{firma}" }, { subject: "{{unbekannt}}" }, { body: `${orig.body}\n{{firma}` }, { body: "{{ firma }}" }, { subject: "Frage firma}}" }]) {
      const r = await request.put(`/api/templates/${a.id}`, { data });
      expect(r.status(), JSON.stringify(data)).toBe(400);
    }
    const now = (await state(request)).templates.find(x => x.id === a.id)!;
    expect([strip(now.subject), now.body]).toEqual([orig.subject, orig.body]);
    expect((await request.put(`/api/templates/${a.id}`, { data: { subject: "Frage an {{firma}}" } })).status()).toBe(200);
  } finally {
    await request.put(`/api/templates/${a.id}`, { data: orig });
  }
});

test("Vorlagen: zweiter Platzhalter landet direkt hinter dem ersten", async ({ page }) => {
  await page.goto("/#vorlagen");
  const body = page.getByLabel("Text", { exact: true });
  await expect(body).not.toHaveValue("");
  /* a late state load would reset the unsaved text */
  await page.waitForLoadState("networkidle");
  const b0 = await body.inputValue();
  await body.click();
  await body.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 0));
  await page.locator(".ph", { hasText: "{{firma}}" }).click();
  await page.locator(".ph", { hasText: "{{vorname}}" }).click();
  await expect(body).toHaveValue(`{{firma}}{{vorname}}${b0}`);
  /* nothing is saved; a reload drops the change */
});

test("Vorlagen: ohne Versand „–“ statt 0,0 %, Quote bricht nicht um", async ({ page, request }) => {
  const ts = (await state(request)).templates;
  await page.goto("/#vorlagen");
  const items = page.locator(".vitem");
  await expect(items).toHaveCount(ts.length);
  for (const [i, x] of ts.entries()) {
    const r = items.nth(i).locator(".rate");
    if (!x.sent) await expect(r).toHaveText("–");
    await expect(r).toHaveCSS("white-space", "nowrap");
  }
  const sw = page.getByRole("switch", { name: "Variante aktiv" });
  await expect(sw).toHaveAttribute("aria-checked", String(ts[0].active));
});

test("Übersicht: A/B-Test ohne Versand zeigt „–“, Zeitraum mit aria-pressed", async ({ page, request }) => {
  const ts = (await state(request)).templates;
  await page.goto("/#statistik");
  const rows = page.locator(".abrow");
  await expect(rows).toHaveCount(ts.length);
  for (const [i, x] of ts.entries()) if (!x.sent) await expect(rows.nth(i).locator(".num")).toHaveText("–");
  const seg = page.locator(".top .seg button");
  await expect(seg.filter({ hasText: "7 Tage" })).toHaveAttribute("aria-pressed", /true|false/);
  await seg.filter({ hasText: "Quartal" }).click();
  await expect(seg.filter({ hasText: "Quartal" })).toHaveAttribute("aria-pressed", "true");
  await expect(seg.filter({ hasText: "7 Tage" })).toHaveAttribute("aria-pressed", "false");
});

test("Leads: nur Vorname wird als Ansprechpartner gezeigt", async ({ page, request }) => {
  const tag = `QA-${Date.now()}`;
  try {
    expect((await request.post("/api/leads", { data: { t: Q, lead: { company: `${tag} Vorname GmbH`, first: "Wiebke" } } })).ok()).toBe(true);
    await page.goto("/#leads");
    await page.getByLabel("Suchen", { exact: true }).fill(tag);
    await expect(page.locator("table.leads tbody tr").first().locator("td.pn")).toHaveText("Wiebke");
  } finally {
    await cleanup(request, tag);
  }
});

test("Import: Einzahl bei einem Kontakt", async ({ page }) => {
  /* the parse result is fixed here, so neither AI nor the database is involved */
  await page.route("**/api/leads/parse", r => r.fulfill({ json: { rows: [{ co: "Einzel GmbH", sal: "", p: "Eva Einzel", role: "", email: "eva@example.com", web: "", city: "", dup: "", extra: "" }] } }));
  await page.goto("/#leads");
  await page.getByRole("button", { name: "Importieren" }).click();
  const dlg = page.getByRole("dialog", { name: "Importieren" });
  await dlg.getByPlaceholder("Liste, Tabelle oder Text einfügen").fill("Einzel GmbH, Eva Einzel, eva@example.com");
  await dlg.getByRole("button", { name: "Daten erkennen" }).click();
  await expect(dlg.locator(".dlg-h")).toHaveText("1 Kontakt erkannt");
  await expect(dlg.getByRole("button", { name: "1 Lead übernehmen" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
});

test("Barrierefreiheit: Navigation, Verbinden-Buttons, Kontrast", async ({ page }) => {
  await page.goto("/#leads");
  await expect(page.locator(".sb .nav[aria-current=page]")).toHaveText(/Leads/);
  await expect(page.locator(".sb .nav[aria-current=page]")).toHaveCount(1);
  for (const theme of ["light", "dark"]) {
    const ratio = await page.evaluate(th => {
      document.documentElement.dataset.theme = th;
      const lum = (c: string) => { const [r, g, b] = c.match(/\d+/g)!.slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const probe = document.createElement("span"); probe.className = "f3"; document.querySelector(".main")!.appendChild(probe);
      const fg = lum(getComputedStyle(probe).color), bg = lum(getComputedStyle(document.querySelector(".main")!).backgroundColor); probe.remove();
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    }, theme);
    expect(ratio, theme).toBeGreaterThanOrEqual(4.5);
  }
  await page.goto("/#einstellungen");
  await page.locator(".tabs button", { hasText: "Integrationen" }).click();
  const names = await page.locator(".int .btn.sec").evaluateAll(bs => bs.map(b => b.getAttribute("aria-label") || b.textContent));
  expect(names.length).toBeGreaterThan(0);
  expect(new Set(names).size).toBe(names.length);
  for (const n of names) expect(n).toMatch(/^.+ verbinden$/);
});

test("Import: Spaltenzuordnung prüfen und ändern", async ({ page }) => {
  /* fixed answers, so neither Jev nor the database is involved */
  await page.route("**/api/leads/columns", r => r.fulfill({ json: { cols: [
    { head: "Firmenname", samples: ["Spalten GmbH"], field: "co" },
    { head: "Telefon", samples: ["0221 1"], field: "" },
    { head: "Kontakt", samples: ["Eva Spalte"], field: "name" },
    { head: "Notiz", samples: ["eva@example.com"], field: "" },
  ] } }));
  let sent: unknown;
  await page.route("**/api/leads/parse", r => { sent = r.request().postDataJSON().map; return r.fulfill({ json: { rows: [{ co: "Spalten GmbH", sal: "", p: "Eva Spalte", role: "", email: "eva@example.com", web: "", city: "", dup: "", extra: "" }] } }); });
  await page.goto("/#leads");
  await page.getByRole("button", { name: "Importieren" }).click();
  const dlg = page.getByRole("dialog", { name: "Importieren" });
  await dlg.getByPlaceholder("Liste, Tabelle oder Text einfügen").fill("Firmenname\tTelefon\tKontakt\tNotiz\nSpalten GmbH\t0221 1\tEva Spalte\teva@example.com");
  await dlg.getByRole("button", { name: "Daten erkennen" }).click();
  await expect(dlg.locator(".dlg-h")).toHaveText("Spalten zuordnen");
  await expect(dlg.getByLabel("Feld für Telefon")).toHaveValue("");
  await dlg.getByLabel("Feld für Notiz").selectOption("email");
  await dlg.getByRole("button", { name: "Kontakte erkennen" }).click();
  await expect(dlg.locator(".dlg-h")).toHaveText("1 Kontakt erkannt");
  expect(sent).toEqual(["co", "", "name", "email"]);
  await dlg.getByRole("button", { name: "Zurück" }).click();
  await expect(dlg.locator(".dlg-h")).toHaveText("Spalten zuordnen");
});
