import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const Q = "qa-testfirma";
type Lead = { id: number; company: string };

const leadsOf = async (request: APIRequestContext) => (await (await request.get(`/api/leads?t=${Q}`)).json()).rows as Lead[];
async function cleanup(request: APIRequestContext, tag: string) {
  for (const l of await leadsOf(request)) if (l.company.includes(tag)) await request.delete(`/api/leads/${l.id}`);
}
async function withLead(request: APIRequestContext, run: (tag: string, co: string) => Promise<void>) {
  const tag = `QA-${Date.now()}`, co = `${tag} Zoë Müller GmbH`;
  try {
    expect((await request.post("/api/leads", { data: { t: Q, lead: { company: co, first: "Jürgen", last: "Straße", email: `${tag.toLowerCase()}.mustermann@musterbau-beispiel.de` } } })).ok()).toBe(true);
    await run(tag, co);
  } finally {
    await cleanup(request, tag);
  }
}

test("Zurück und Vor wechseln zwischen Ansichten", async ({ page }) => {
  await page.goto("/#freigabe");
  await expect(page.locator(".sb .ws")).toContainText("QA Testfirma");
  await page.locator(".sb .nav", { hasText: "Leads" }).click();
  await page.locator(".sb .nav", { hasText: "Übersicht" }).click();
  await page.locator(".sb .nav", { hasText: "Übersicht" }).click();
  await page.goBack();
  await expect(page.locator(".sb .nav.on")).toContainText("Leads");
  await page.goBack();
  await expect(page.locator(".sb .nav.on")).toContainText("Freigabe");
  await expect(page).toHaveURL(/#freigabe/);
  await page.goForward();
  await expect(page.locator(".sb .nav.on")).toContainText("Leads");
});

test("/login mit Sitzung leitet auf die App", async ({ page }) => {
  await page.goto("/login");
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.locator(".sb .ws")).toContainText("QA Testfirma");
});

test("nach Abmelden zeigt Zurück die Anmeldung", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ storageState: "test-results/.auth.json", baseURL });
  const page = await ctx.newPage();
  await page.goto("/#leads");
  await expect(page.locator(".sb .nav.on")).toContainText("Leads");
  await page.locator(".sb .me").click();
  await page.getByRole("button", { name: "Abmelden" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goBack();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Anmelden" })).toBeVisible();
  await ctx.close();
});

async function csvRows(page: Page) {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(".top .btn.sec").click()]);
  return readFileSync((await dl.path())!, "utf8").trim().split("\n").length - 1;
}

test("Übersicht: Zeitraum steuert Diagramm und Export", async ({ page }) => {
  await page.goto("/#statistik");
  const bars = page.locator(".chart svg g title");
  const seg = (n: string) => page.locator(".top .seg button", { hasText: n });
  await seg("7 Tage").click();
  await expect(bars).toHaveCount(7);
  expect(await csvRows(page)).toBe(7);
  await seg("30 Tage").click();
  await expect(bars).toHaveCount(30);
  expect(await csvRows(page)).toBe(30);
  await seg("Quartal").click();
  await expect.poll(() => bars.count()).toBeLessThan(20);
  expect(await csvRows(page)).toBe(90);
  await seg("Seit Start").click();
  expect(await csvRows(page)).toBeGreaterThanOrEqual(7);
});

test("Übersicht: Quote ohne Versand als Strich, Spalte Person benannt", async ({ page }) => {
  await page.goto("/#statistik");
  await page.locator(".top .seg button", { hasText: "7 Tage" }).click();
  const kpi = (l: string) => page.locator(".kpi", { hasText: l }).locator(".v");
  if ((await kpi("Gesendet").innerText()).trim() === "0") await expect(kpi("Antwortquote")).toHaveText("–");
  await expect(page.locator(".blk", { hasText: "Nach Person" }).locator("th").first()).toHaveText("Person");
});

test("Leads: Zeile per Tastatur öffnen", async ({ page, request }) => {
  await withLead(request, async tag => {
    await page.goto("/#leads");
    await page.getByLabel("Suchen").fill(tag);
    const row = page.locator("table.leads tbody tr", { hasText: tag });
    await expect(row).toHaveAttribute("tabindex", "0");
    await row.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".dlg")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".dlg")).toHaveCount(0);
    await row.focus();
    await page.keyboard.press(" ");
    await expect(page.locator(".dlg")).toBeVisible();
  });
});

test("Leads: Suche ignoriert Akzente und Umlaute", async ({ page, request }) => {
  await withLead(request, async tag => {
    await page.goto("/#leads");
    const row = page.locator("table.leads tbody tr", { hasText: tag });
    for (const q of ["ZOE MUELLER", "zoe muller", "juergen strasse"]) {
      await page.getByLabel("Suchen").fill(q);
      await expect(row, q).toHaveCount(1);
    }
  });
});

test("⌘K findet Leads und öffnet sie", async ({ page, request }) => {
  await withLead(request, async tag => {
    await page.goto("/#freigabe");
    await expect(page.locator(".sb .ws")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByLabel("Befehl suchen").fill(tag.toLowerCase());
    const item = page.locator(".pal button", { hasText: tag });
    await expect(item).toHaveCount(1);
    await item.click();
    await expect(page.locator(".sb .nav.on")).toContainText("Leads");
    await expect(page.locator(".dlg")).toBeVisible();
  });
});

test.describe("Mobil 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  const inView = async (page: Page, sel: string) => {
    const b = await page.locator(sel).first().boundingBox();
    expect(b, sel).not.toBeNull();
    expect(b!.x + b!.width, sel).toBeLessThanOrEqual(390);
  };

  test("Übersicht: Kopfzeile passt, Tabelle vollständig", async ({ page }) => {
    await page.goto("/#statistik");
    await inView(page, ".top .btn.sec");
    for (const b of await page.locator(".top .seg button").all()) expect((await b.boundingBox())!.height).toBeLessThanOrEqual(30);
    await inView(page, ".blk:has-text('Nach Person') th:has-text('Quote')");
    expect((await page.locator(".blk h3", { hasText: "A/B-Test" }).boundingBox())!.height).toBeLessThanOrEqual(32);
  });

  test("Vorlagen: Speichern sichtbar", async ({ page }) => {
    await page.goto("/#vorlagen");
    await inView(page, ".top .btn:has-text('Speichern')");
  });

  /* the e-mail column is hidden below 640px on purpose since the contact redesign */
  test("Leads: Firma sichtbar, kein seitliches Scrollen", async ({ page, request }) => {
    await withLead(request, async tag => {
      await page.goto("/#leads");
      await expect(page.locator("table.leads tbody tr", { hasText: tag })).toHaveCount(1);
      await inView(page, "table.leads th:has-text('Firma')");
      expect(await page.locator(".tbl").first().evaluate(t => t.scrollWidth - t.clientWidth)).toBeLessThanOrEqual(1);
    });
  });

  test("Einrichtung: nur ein Menü-Symbol", async ({ page }) => {
    await page.goto("/#einrichtung");
    await expect(page.locator(".top .mob")).toBeVisible();
    await expect(page.locator(".top svg.lucide-menu:visible")).toHaveCount(1);
  });
});
