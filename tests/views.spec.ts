import { expect, test } from "@playwright/test";

const VIEWS = ["einrichtung", "statistik", "leads", "vorlagen", "einstellungen"];

for (const v of VIEWS) {
  test(`Ansicht ${v} lädt ohne Fehler`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()); });
    /* tenant icons 404 on purpose when a site has none; the client keeps the initials */
    page.on("response", r => { if (r.status() === 404 && !/\/api\/tenants\/[^/]+\/icon$/.test(r.url())) errors.push(`404 ${r.url()}`); });
    page.on("response", r => { if (r.url().includes("/api/") && r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
    await page.goto(`/#${v}`);
    await expect(page.locator(".sb .ws")).toContainText("QA Testfirma");
    await expect(page.locator(".main")).not.toBeEmpty();
    await page.waitForLoadState("networkidle");
    expect(errors).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow, "horizontaler Scroll").toBeLessThanOrEqual(1);
  });
}
