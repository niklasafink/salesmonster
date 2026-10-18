import { expect, test, type APIRequestContext } from "@playwright/test";

const Q = "qa-testfirma";
type Tpl = { id: number; key: string; subject: string; body: string; active: boolean };

const tpls = async (request: APIRequestContext) => (await (await request.get(`/api/state?t=${Q}`)).json()).templates as Tpl[];
/* a value left behind by an aborted run must not become the "original" */
const strip = (s: string) => s.replace(/ QA-\d{13}/g, "");

test("Betreff speichern bleibt nach Reload, danach Original zurück", async ({ page, request }) => {
  const a = (await tpls(request)).find(x => x.key === "A")!;
  const orig = strip(a.subject), tag = `QA-${Date.now()}`;
  try {
    await page.goto("/#vorlagen");
    await page.locator(".vitem", { hasText: "A" }).first().click();
    const subj = page.getByLabel("Betreff");
    await expect(subj).not.toHaveValue("");
    await subj.fill(`${orig} ${tag}`);
    await page.locator(".top").getByRole("button", { name: "Speichern" }).click();
    await expect(page.locator(".toast")).toContainText("gespeichert");
    await page.reload();
    await page.locator(".vitem", { hasText: "A" }).first().click();
    await expect(page.getByLabel("Betreff")).toHaveValue(`${orig} ${tag}`);
  } finally {
    await request.put(`/api/templates/${a.id}`, { data: { subject: orig } });
  }
  expect((await tpls(request)).find(x => x.key === "A")!.subject).toBe(orig);
});

test("Vorschau ersetzt die Platzhalter", async ({ page }) => {
  await page.goto("/#vorlagen");
  await expect(page.getByLabel("Betreff")).toBeVisible();
  await page.getByRole("button", { name: "Vorschau" }).click();
  await expect(page.locator(".doc .subj")).not.toBeEmpty();
  await expect(page.locator(".doc .subj")).not.toContainText("{{");
  await expect(page.locator(".doc .mailpv")).not.toContainText("{{");
  await page.screenshot({ path: "test-results/vorlagen-vorschau.png" });
  await page.getByRole("button", { name: "Bearbeiten" }).click();
  await expect(page.getByLabel("Betreff")).toBeVisible();
});

test("Neue Vorlage anlegen, umbenennen und wieder löschen", async ({ page, request }) => {
  const before = (await tpls(request)).map(x => x.key);
  await page.goto("/#vorlagen");
  await expect(page.getByLabel("Betreff")).toBeVisible();
  await page.getByRole("button", { name: "Neue Vorlage" }).click();
  const fresh = async () => (await tpls(request)).find(x => !before.includes(x.key));
  await expect.poll(fresh).toBeTruthy();
  const t = (await fresh())!;
  try {
    expect(t.active).toBe(false);
    const name = page.getByLabel("Name der Vorlage");
    await expect(name).toHaveValue(`Vorlage ${t.key}`);
    await name.fill("QA Umbenannt");
    await page.getByLabel("Betreff").fill("QA Betreff");
    await page.locator(".top").getByRole("button", { name: "Speichern" }).click();
    await expect(page.locator(".toast")).toContainText("QA Umbenannt gespeichert");
    await expect(page.locator(".vitem.on")).toContainText("QA Umbenannt");
    await page.screenshot({ path: "test-results/vorlagen-neu.png" });
    page.once("dialog", d => d.accept());
    await page.getByRole("button", { name: "Vorlage löschen" }).click();
    await expect(page.locator(".toast")).toContainText("gelöscht");
    await expect(page.locator(".vitem", { hasText: "QA Umbenannt" })).toHaveCount(0);
  } finally {
    await request.delete(`/api/templates/${t.id}`);
  }
});

test("Platzhalter einfügen ändert nur den Entwurf", async ({ page, request }) => {
  const before = (await tpls(request)).find(x => x.key === "A")!.body;
  await page.goto("/#vorlagen");
  const body = page.getByLabel("Text");
  await expect(body).toBeVisible();
  await body.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.locator(".phs .ph").first().click();
  await expect(body).not.toHaveValue(before);
  /* nothing saved: the server copy is unchanged */
  expect((await tpls(request)).find(x => x.key === "A")!.body).toBe(before);
});
