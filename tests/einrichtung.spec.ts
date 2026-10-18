import { expect, test, type APIRequestContext } from "@playwright/test";

const Q = "qa-testfirma";
type Setup = { step: string; prompts: Record<string, string> };

/* all tests touch the one setup row of the QA tenant */
test.describe.configure({ mode: "serial" });

const setup = async (request: APIRequestContext) => (await (await request.get(`/api/setup?t=${Q}`)).json()) as { setup: Setup; ai: boolean };
const post = (request: APIRequestContext, body: Record<string, unknown>) => request.post("/api/setup", { data: { t: Q, ...body } });

test.beforeEach(async ({ request }) => {
  test.skip((await setup(request)).ai, "QA hat eine KI verbunden, die Einrichtung würde ein bezahltes Modell aufrufen");
});

test("ohne KI fragt die Einrichtung nach dem Schlüssel", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", r => { if (r.url().includes("/api/setup") && r.method() === "POST") posts.push(r.postData() || ""); });
  page.on("response", r => { if (r.url().includes("/api/") && r.status() >= 500) posts.push(`${r.status()} ${r.url()}`); });
  await page.goto("/#einrichtung");
  await expect(page.locator(".cl-thread")).toContainText("brauche ich Zugriff auf eine KI", { timeout: 15_000 });
  await expect(page.getByLabel("Antwort")).toHaveAttribute("placeholder", "API-Schlüssel einfügen");
  await expect(page.locator(".cl-rail .cl-sh")).toHaveCount(6);
  await page.waitForLoadState("networkidle");
  expect(posts, "ohne KI kein Start-Aufruf und kein 5xx").toEqual([]);
});

test("Schritt wechseln ohne KI und zurück", async ({ page, request }) => {
  const orig = (await setup(request)).setup.step;
  try {
    await page.goto("/#einrichtung");
    const step = (n: string) => page.locator(".cl-rail .cl-sh", { hasText: n });
    await step("Zielgruppe").click();
    const dlg = page.locator(".dlg");
    await expect(dlg.locator(".dlg-h")).toContainText("Zielgruppe");
    await dlg.getByRole("button", { name: "Zu diesem Schritt" }).click();
    await expect(step("Zielgruppe")).toHaveAttribute("aria-current", "step");
    expect((await setup(request)).setup.step).toBe("zielgruppe");
    await expect(page.locator(".toast")).toHaveCount(0);

    await step("Unternehmen").click();
    await dlg.getByRole("button", { name: "Zu diesem Schritt" }).click();
    await expect(step("Unternehmen")).toHaveAttribute("aria-current", "step");
  } finally {
    await post(request, { action: "goto", step: orig });
  }
  expect((await setup(request)).setup.step).toBe(orig);
});

test("Schritt-Prompt speichern, nach Reload da, danach zurück", async ({ page, request }) => {
  const orig = (await setup(request)).setup.prompts.zielgruppe ?? "", tag = `QA-${Date.now()}`;
  try {
    await page.goto("/#einrichtung");
    await page.locator(".cl-rail .cl-sh", { hasText: "Zielgruppe" }).click();
    const dlg = page.locator(".dlg");
    await dlg.getByLabel("Branchen", { exact: true }).fill(tag);
    await expect(dlg.locator("textarea.prompt")).toHaveValue(new RegExp(`^Branchen: ${tag}$`, "m"));
    await dlg.getByRole("button", { name: "Speichern" }).click();
    await expect(dlg).toHaveCount(0);
    await page.reload();
    await page.locator(".cl-rail .cl-sh", { hasText: "Zielgruppe" }).click();
    /* the label wraps the textarea, so its value is part of the label text once filled */
    await expect(dlg.locator("textarea.keys")).toHaveValue(tag);
    await dlg.getByRole("button", { name: "Abbrechen" }).click();
  } finally {
    await post(request, { action: "prompt", step: "zielgruppe", text: orig.includes("QA-") ? "" : orig });
  }
  expect((await setup(request)).setup.prompts.zielgruppe ?? "").not.toContain(tag);
});
