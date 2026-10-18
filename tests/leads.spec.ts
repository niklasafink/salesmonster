import { expect, test, type APIRequestContext } from "@playwright/test";

const Q = "qa-testfirma";
type Lead = { id: number; company: string; email: string; role: string; city: string; status: string };

const leadsOf = async (request: APIRequestContext) => (await (await request.get(`/api/leads?t=${Q}`)).json()).rows as Lead[];

/* removes only the leads of this test (tag in the company name), so a parallel loop run keeps its own */
async function cleanup(request: APIRequestContext, tag: string) {
  for (const l of await leadsOf(request)) if (l.company.includes(tag)) await request.delete(`/api/leads/${l.id}`);
}

/* leftovers of aborted runs: tags older than 15 minutes */
test.beforeEach(async ({ request }) => {
  for (const l of await leadsOf(request)) {
    const ts = Number(/QA-(\d{13})/.exec(l.company)?.[1]);
    if (ts && Date.now() - ts > 15 * 60_000) await request.delete(`/api/leads/${l.id}`);
  }
});

test("Bearbeiten-Dialog: Speichern bei 1280×720 erreichbar", async ({ page, request }) => {
  const tag = `QA-${Date.now()}`, co = `${tag} Fold GmbH`;
  try {
    expect((await request.post("/api/leads", { data: { t: Q, lead: { company: co, first: "Fold", last: "Test" } } })).ok()).toBe(true);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/#leads");
    await page.getByLabel("Suchen").fill(tag);
    await page.locator("table.leads tbody tr", { hasText: "Fold Test" }).first().click();
    const btn = page.locator(".dlg").getByRole("button", { name: "Speichern" });
    await expect(btn).toBeVisible();
    await btn.scrollIntoViewIfNeeded();
    await expect(btn).toBeInViewport();
  } finally {
    await cleanup(request, tag);
  }
});

test("Kontakt anlegen, bearbeiten und löschen", async ({ page, request }) => {
  const tag = `QA-${Date.now()}`, co = `${tag} Testbau GmbH`;
  await page.setViewportSize({ width: 1280, height: 1200 });
  try {
    await page.goto("/#leads");
    await page.getByRole("button", { name: "Kontakt", exact: true }).click();
    const dlg = page.locator(".dlg");
    await expect(dlg.locator(".dlg-h")).toContainText("Kontakt hinzufügen");
    await dlg.getByLabel("Vorname", { exact: true }).fill("Erika");
    await dlg.getByLabel("Nachname", { exact: true }).fill("Muster");
    await dlg.getByLabel("Firma", { exact: true }).fill(co);
    await dlg.getByLabel("E-Mail", { exact: true }).fill(`erika.${tag.toLowerCase()}@example.com`);
    await dlg.getByRole("button", { name: "Speichern" }).click();
    await expect(page.locator(".toast")).toContainText("Gespeichert");
    await expect(dlg).toHaveCount(0);

    await page.getByLabel("Suchen").fill(tag);
    const row = page.locator("table.leads tbody tr", { hasText: co });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Erika Muster");

    await row.click();
    await expect(dlg.locator(".dlg-h")).toContainText("Erika Muster");
    await dlg.getByLabel("Ort", { exact: true }).fill("Bielefeld");
    await dlg.getByLabel("E-Mail", { exact: true }).fill(`e.muster.${tag.toLowerCase()}@example.com`);
    await dlg.getByRole("button", { name: "Speichern" }).click();
    await expect(page.locator(".toast")).toContainText("Gespeichert");
    await expect(row).toContainText(`e.muster.${tag.toLowerCase()}@example.com`);
    const saved = (await leadsOf(request)).find(l => l.company === co);
    expect(saved?.city).toBe("Bielefeld");

    /* "Löschen" moves the lead to the trash; it stays in the data so research and import recognise it */
    await row.click();
    await dlg.getByRole("button", { name: "Löschen" }).click();
    await expect(page.locator(".toast")).toContainText("In den Papierkorb gelegt");
    await expect(row).toHaveCount(0);
    expect((await leadsOf(request)).find(l => l.company === co)?.status).toBe("papierkorb");
  } finally {
    await cleanup(request, tag);
  }
});

test("Kontakt ohne Firma lässt sich nicht speichern", async ({ page }) => {
  await page.goto("/#leads");
  await page.getByRole("button", { name: "Kontakt", exact: true }).click();
  const dlg = page.locator(".dlg");
  await dlg.getByLabel("Vorname", { exact: true }).fill("Ohne");
  await expect(dlg.getByRole("button", { name: "Speichern" })).toBeDisabled();
  await dlg.getByLabel("Firma", { exact: true }).fill("   ");
  await expect(dlg.getByRole("button", { name: "Speichern" })).toBeDisabled();
  await dlg.getByRole("button", { name: "Abbrechen" }).click();
  await expect(dlg).toHaveCount(0);
});

test("Import erkennt Text ohne KI, markiert Dubletten", async ({ page, request }) => {
  const s = await (await request.get(`/api/setup?t=${Q}`)).json();
  test.skip(s.ai, "QA hat eine KI verbunden, der Import würde ein bezahltes Modell aufrufen");
  const tag = `QA-${Date.now()}`, co = `${tag} Tiefbau GmbH`, mail = `max.${tag.toLowerCase()}@example.com`;
  const text = `${co} – GF: Herr Max Muster – ${mail} – www.example.com`;
  try {
    await page.goto("/#leads");
    await page.getByRole("button", { name: "Importieren" }).click();
    const dlg = page.locator(".dlg");
    await expect(dlg.getByRole("button", { name: "Daten erkennen" })).toBeDisabled();
    await dlg.getByPlaceholder("Liste, Tabelle oder Text einfügen").fill(text);
    await dlg.getByRole("button", { name: "Daten erkennen" }).click();
    await expect(dlg.locator(".dlg-h")).toContainText("1 Kontakt erkannt");
    await dlg.getByLabel("Quelle").fill(tag);
    await expect(dlg).toContainText(co);
    await expect(dlg).toContainText("Herr Max Muster");
    await expect(dlg).toContainText(mail);
    await dlg.getByRole("button", { name: "1 Lead übernehmen" }).click();
    await expect(page.locator(".toast")).toContainText("1 Lead übernommen");
    await page.getByLabel("Suchen").fill(tag);
    await expect(page.locator("table.leads tbody tr", { hasText: co })).toHaveCount(1);

    /* the same text again is recognised as already in the list */
    const r = await request.post("/api/leads/parse", { data: { t: Q, text } });
    expect(r.status()).toBe(200);
    expect((await r.json()).rows[0].dup).toBe("Schon in der Liste");
  } finally {
    await cleanup(request, tag);
  }
  expect((await leadsOf(request)).some(l => l.company.includes(tag))).toBe(false);
});

test("Import mit leerem Text liefert 400", async ({ request }) => {
  const r = await request.post("/api/leads/parse", { data: { t: Q, text: "   " } });
  expect(r.status()).toBe(400);
  expect((await r.json()).error).toBe("Keine Daten");
});
