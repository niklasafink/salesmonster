import { expect, test, type APIRequestContext } from "@playwright/test";

const Q = "qa-testfirma";
type Settings = { prompt: string; leadsPerDay: number };

/* all tests touch tenant settings */
test.describe.configure({ mode: "serial" });

const settings = async (request: APIRequestContext) => (await (await request.get(`/api/state?t=${Q}`)).json()).tenant.settings as Settings;
const patch = (request: APIRequestContext, s: Partial<Settings>) => request.patch(`/api/tenants/${Q}`, { data: { settings: s } });

test("Ablauf: Leads pro Tag speichern, nach Reload da, danach zurück", async ({ page, request }) => {
  const orig = (await settings(request)).leadsPerDay, next = orig === 7 ? 8 : 7;
  try {
    await page.goto("/#einstellungen");
    const n = page.getByLabel("Leads pro Tag");
    await expect(n).toHaveValue(String(orig));
    const saved = page.waitForResponse(r => r.url().includes(`/api/tenants/${Q}`) && r.request().method() === "PATCH");
    await n.fill(String(next));
    expect((await saved).status()).toBe(200);
    await page.reload();
    await page.locator(".tabs button", { hasText: "Ablauf" }).click();
    await expect(page.getByLabel("Leads pro Tag")).toHaveValue(String(next));
  } finally {
    await patch(request, { leadsPerDay: orig });
  }
  expect((await settings(request)).leadsPerDay).toBe(orig);
});

test("Leads pro Tag wird auf 1 bis 30 begrenzt", async ({ request }) => {
  const orig = (await settings(request)).leadsPerDay;
  try {
    expect((await patch(request, { leadsPerDay: 999 })).status()).toBe(200);
    expect((await settings(request)).leadsPerDay).toBe(30);
    expect((await patch(request, { leadsPerDay: -5 })).status()).toBe(200);
    expect((await settings(request)).leadsPerDay).toBe(1);
  } finally {
    await patch(request, { leadsPerDay: orig });
  }
});

test("Integrationen: Dialog öffnen und ohne Verbinden schließen", async ({ page }) => {
  await page.goto("/#einstellungen");
  await page.locator(".tabs button", { hasText: "Integrationen" }).click();
  const row = page.locator(".row2.int", { hasText: "HubSpot" });
  await expect(row).toBeVisible();
  await expect(row).not.toContainText("Verbunden");
  await row.getByRole("button", { name: "Verbinden" }).click();
  const dlg = page.locator("form.dlg");
  await expect(dlg.locator(".dlg-h")).toContainText("HubSpot verbinden");
  await dlg.getByRole("button", { name: "Schließen" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(row).not.toContainText("Verbunden");
});
