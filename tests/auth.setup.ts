import { expect, test as setup } from "@playwright/test";

setup("anmelden als QA", async ({ page }) => {
  expect(process.env.QA_EMAIL, "QA_EMAIL fehlt in .env.local (scripts/qa-user.ts)").toBeTruthy();
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(process.env.QA_EMAIL!);
  await page.getByLabel("Passwort", { exact: true }).fill(process.env.QA_PASSWORD!);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.locator(".sb .ws")).toContainText("QA Testfirma");
  await page.context().storageState({ path: "test-results/.auth.json" });
});
