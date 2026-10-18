import { expect, test } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

test("ohne Anmeldung landet man auf /login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Anmelden" })).toBeVisible();
});

test("falsches Passwort zeigt Fehler", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill("qa@salesmonster.invalid");
  await page.getByLabel("Passwort", { exact: true }).fill("falsch-falsch");
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.locator(".warn")).toHaveText("E-Mail oder Passwort falsch");
});

test("Passwort anzeigen/verbergen", async ({ page }) => {
  await page.goto("/login");
  const pw = page.getByLabel("Passwort", { exact: true });
  await pw.fill("geheim");
  await expect(pw).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Passwort anzeigen" }).click();
  await expect(pw).toHaveAttribute("type", "text");
});

for (const path of ["/api/state", "/api/stats", "/api/customers", "/api/leads", "/api/integrations", "/api/setup"]) {
  test(`API ${path} verlangt Anmeldung`, async ({ request }) => {
    const r = await request.get(path, { maxRedirects: 0 });
    expect([401, 403, 307, 308]).toContain(r.status());
  });
}

for (const path of ["/api/cron/evening", "/api/cron/morning"]) {
  test(`Cron ${path} ohne Secret abgelehnt`, async ({ request }) => {
    const r = await request.get(path, { maxRedirects: 0 });
    expect(r.status()).not.toBe(200);
  });
}

test("Login mit leerem Body liefert 401, keinen 500", async ({ request }) => {
  const r = await request.post("/api/auth/login", { data: {} });
  expect(r.status()).toBe(401);
});
