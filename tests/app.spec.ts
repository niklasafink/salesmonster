import { expect, test } from "@playwright/test";

test("Navigation über die Sidebar", async ({ page }) => {
  await page.goto("/#freigabe");
  for (const name of ["Übersicht", "Leads", "Vorlagen", "Einstellungen", "Freigabe"]) {
    await page.locator(".sb .nav", { hasText: name }).click();
    await expect(page.locator(".sb .nav.on")).toContainText(name);
  }
});

test("Befehlspalette mit ⌘K", async ({ page }) => {
  await page.goto("/#freigabe");
  await expect(page.locator(".sb .ws")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByLabel("Befehl suchen");
  await expect(input).toBeVisible();
  await input.fill("Leads");
  await page.keyboard.press("Enter");
  await expect(page.locator(".sb .nav.on")).toContainText("Leads");
  await expect(page).toHaveURL(/#leads/);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByLabel("Befehl suchen").fill("xyz-gibt-es-nicht");
  await expect(page.locator(".pal")).toContainText("Nichts gefunden");
  await page.keyboard.press("Escape");
  await expect(page.locator(".pal")).toHaveCount(0);
});

test("Hell/Dunkel umschalten bleibt nach Reload", async ({ page }) => {
  await page.goto("/#freigabe");
  await page.locator(".sb .me").click();
  await page.getByRole("button", { name: "Hell / Dunkel" }).click();
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(theme).toMatch(/light|dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme!);
});

test("QA sieht nur den eigenen Mandanten", async ({ page }) => {
  await page.goto("/#freigabe");
  await page.locator(".sb .ws").click();
  const list = page.getByRole("dialog", { name: "Unternehmen" });
  await expect(list).toBeVisible();
  await expect(list.locator(".tl button")).toHaveCount(1);
  await expect(list).not.toContainText("Vergabehero");
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
});

test("fremder Mandant per API nicht lesbar", async ({ request }) => {
  for (const slug of ["vh", "conformis-grc", "chetti"]) {
    const r = await request.get(`/api/state?t=${slug}`);
    if (r.ok()) {
      const j = await r.json();
      expect(j.tenant?.slug, `Mandant ${slug} sichtbar`).not.toBe(slug);
      expect(JSON.stringify(j)).not.toContain("Vergabehero");
    }
    const s = await request.get(`/api/stats?t=${slug}`);
    if (s.ok()) expect(JSON.stringify(await s.json())).not.toContain("Vergabehero");
  }
});

test("Passwort-Dialog lehnt falsches aktuelles Passwort ab", async ({ page }) => {
  await page.goto("/#freigabe");
  await page.locator(".sb .me").click();
  await page.getByRole("button", { name: "Passwort ändern" }).click();
  await page.getByLabel("Aktuelles Passwort").fill("definitiv-falsch");
  await page.getByLabel("Neues Passwort").fill("NeuesPasswort123!");
  const dlg = page.locator("form.dlg");
  await dlg.getByRole("button", { name: "Speichern" }).click();
  await expect(dlg.locator(".warn")).toBeVisible();
  await expect(page.locator(".toast")).toHaveCount(0);
});
