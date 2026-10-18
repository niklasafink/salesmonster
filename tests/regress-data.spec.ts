import { expect, test, type APIRequestContext } from "@playwright/test";

/* Regressions from the QA round: data checks on leads, import without AI, templates, settings. Writes only to the QA tenant. */
const Q = "qa-testfirma";
type Lead = { id: number; company: string; email: string; website: string; linkedin: string; sourceUrl: string };
type Tpl = { id: number; key: string; subject: string; body: string; active: boolean };
type State = { tenant: { settings: { leadsPerDay: number } }; templates: Tpl[]; integ: Record<string, { on: boolean }> };

const state = async (request: APIRequestContext) => (await (await request.get(`/api/state?t=${Q}`)).json()) as State;
const leadsOf = async (request: APIRequestContext) => (await (await request.get(`/api/leads?t=${Q}`)).json()).rows as Lead[];
const noAi = async (request: APIRequestContext) => { const s = await state(request); return !s.integ.claude?.on && !s.integ.openrouter?.on; };
const strip = (s: string) => s.replace(/ QA-\d{13}/g, "");

async function cleanup(request: APIRequestContext, tag: string) {
  for (const l of await leadsOf(request)) if (l.company.includes(tag)) await request.delete(`/api/leads/${l.id}`);
}
const add = async (request: APIRequestContext, lead: Record<string, string>) => request.post("/api/leads", { data: { t: Q, lead } });

test("Recherche ohne KI liefert 400 mit Meldung", async ({ request }) => {
  test.skip(!(await noAi(request)), "QA-Mandant hat eine KI verbunden");
  const r = await request.post("/api/run", { data: { t: Q, job: "research" } });
  expect(r.status()).toBe(400);
  expect((await r.json()).error).toContain("Keine KI verbunden");
});

test("Einstellungen → Ablauf: Recherche ohne KI zeigt die Meldung", async ({ page, request }) => {
  test.skip(!(await noAi(request)), "QA-Mandant hat eine KI verbunden");
  await page.goto("/#einstellungen");
  await page.locator(".tabs button", { hasText: "Ablauf" }).click();
  await page.getByRole("button", { name: "Jetzt recherchieren" }).click();
  await expect(page.locator(".toast")).toContainText("Keine KI verbunden");
});

test("Import ohne KI: Tabellen mit Kopfzeile behalten die Namen", async ({ request }) => {
  test.skip(!(await noAi(request)), "QA-Mandant hat eine KI verbunden");
  const tag = `QA-${Date.now()}`;
  const cases = [
    `Firma;Vorname;Nachname;E-Mail\n${tag} Semi GmbH;Erika;Muster;erika.${tag}@example.com`,
    `Company,First name,Last name,Email,Website,City,Role\n${tag} Comma GmbH,Erika,Muster,erika.${tag}@example.com,example.com,Berlin,CEO`,
    `Firma\tAnsprechpartner\tE-Mail\n${tag} Tab GmbH\tErika Muster\terika.${tag}@example.com`,
  ];
  for (const text of cases) {
    const r = await request.post("/api/leads/parse", { data: { t: Q, text } });
    expect(r.status(), text).toBe(200);
    const rows = (await r.json()).rows as { co: string; p: string; email: string }[];
    expect(rows, text).toHaveLength(1);
    expect(rows[0].co).toContain(tag);
    expect(rows[0].p, text).toBe("Erika Muster");
    expect(rows[0].email).toBe(`erika.${tag}@example.com`);
  }
  const r = await request.post("/api/leads/parse", { data: { t: Q, text: cases[1] } });
  const [row] = (await r.json()).rows as { web: string; city: string; role: string }[];
  expect([row.web, row.city, row.role]).toEqual(["example.com", "Berlin", "CEO"]);
});

test("Doppelte E-Mail wird beim Anlegen und Ändern abgelehnt", async ({ request }) => {
  const tag = `QA-${Date.now()}`, mail = `dup.${tag.toLowerCase()}@example.com`;
  try {
    expect((await add(request, { company: `${tag} Eins GmbH`, email: mail })).status()).toBe(200);
    const r = await add(request, { company: `${tag} Zwei GmbH`, email: mail.toUpperCase() });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe("Schon in der Liste");

    const other = await add(request, { company: `${tag} Drei GmbH`, email: `other.${tag.toLowerCase()}@example.com` });
    expect(other.status()).toBe(200);
    const { id } = await other.json() as { id: number };
    const p = await request.patch(`/api/leads/${id}`, { data: { email: mail } });
    expect(p.status()).toBe(400);
    expect((await p.json()).error).toBe("Schon in der Liste");
    /* the lead's own address is no duplicate */
    expect((await request.patch(`/api/leads/${id}`, { data: { email: `OTHER.${tag.toLowerCase()}@example.com`, city: "Halle" } })).status()).toBe(200);
  } finally {
    await cleanup(request, tag);
  }
});

test("Ungültige E-Mail wird abgelehnt", async ({ request }) => {
  const tag = `QA-${Date.now()}`;
  try {
    for (const email of ["kaputt@", "kaputt", "a@b", "a b@example.com"]) {
      const r = await add(request, { company: `${tag} Mail GmbH`, email });
      expect(r.status(), email).toBe(400);
      expect((await r.json()).error).toBe("E-Mail ungültig");
    }
    const ok = await add(request, { company: `${tag} Mail GmbH`, email: `ok.${tag.toLowerCase()}@example.com` });
    expect(ok.status()).toBe(200);
    const p = await request.patch(`/api/leads/${(await ok.json()).id}`, { data: { email: "kaputt@" } });
    expect(p.status()).toBe(400);
    expect((await p.json()).error).toBe("E-Mail ungültig");
  } finally {
    await cleanup(request, tag);
  }
});

test("Website und LinkedIn: nur http(s)", async ({ request }) => {
  const tag = `QA-${Date.now()}`;
  try {
    const r = await add(request, { company: `${tag} Link GmbH`, website: "javascript:alert(1)", linkedin: "linkedin.com/in/qa", sourceUrl: "data:text/html,x" });
    expect(r.status()).toBe(200);
    const { id } = await r.json() as { id: number };
    let l = (await leadsOf(request)).find(x => x.id === id)!;
    expect([l.website, l.linkedin, l.sourceUrl]).toEqual(["", "https://linkedin.com/in/qa", ""]);

    expect((await request.patch(`/api/leads/${id}`, { data: { website: "www.example.com", linkedin: "JavaScript:alert(1)" } })).status()).toBe(200);
    l = (await leadsOf(request)).find(x => x.id === id)!;
    expect([l.website, l.linkedin]).toEqual(["https://www.example.com", ""]);
  } finally {
    await cleanup(request, tag);
  }
});

test("Aktive Vorlage ohne Betreff oder Text wird abgelehnt", async ({ request }) => {
  /* not A, which vorlagen.spec edits */
  const ts = (await state(request)).templates, a = ts.find(x => x.active && x.key !== "A") || ts.find(x => x.active)!;
  const orig = { subject: strip(a.subject), body: a.body };
  try {
    for (const data of [{ subject: "   " }, { body: "" }, { subject: "", body: "x" }]) {
      const r = await request.put(`/api/templates/${a.id}`, { data });
      expect(r.status(), JSON.stringify(data)).toBe(400);
    }
    const now = (await state(request)).templates.find(x => x.id === a.id)!;
    expect([now.subject, now.body]).toEqual([orig.subject, orig.body]);
  } finally {
    await request.put(`/api/templates/${a.id}`, { data: orig });
  }
});

test("Leads pro Tag: Server rundet auf ganze Zahlen", async ({ request }) => {
  const orig = (await state(request)).tenant.settings.leadsPerDay;
  try {
    expect((await request.patch(`/api/tenants/${Q}`, { data: { settings: { leadsPerDay: 2.6 } } })).status()).toBe(200);
    expect((await state(request)).tenant.settings.leadsPerDay).toBe(3);
  } finally {
    await request.patch(`/api/tenants/${Q}`, { data: { settings: { leadsPerDay: orig } } });
  }
});

test("Leads pro Tag: Feld zeigt den begrenzten Wert", async ({ page, request }) => {
  const orig = (await state(request)).tenant.settings.leadsPerDay;
  try {
    await page.goto("/#einstellungen");
    await page.locator(".tabs button", { hasText: "Ablauf" }).click();
    const n = page.getByLabel("Leads pro Tag");
    await expect(n).toHaveAttribute("type", "number");
    for (const [v, shown] of [["99999", "30"], ["-5", "1"], ["0", "1"]]) {
      await n.fill(v);
      await n.blur();
      await expect(n).toHaveValue(shown);
      await expect.poll(async () => (await state(request)).tenant.settings.leadsPerDay).toBe(Number(shown));
    }
  } finally {
    await request.patch(`/api/tenants/${Q}`, { data: { settings: { leadsPerDay: orig } } });
  }
});

test("Kontakt-Dialog: role=dialog und Escape schließt", async ({ page }) => {
  await page.goto("/#leads");
  await page.getByRole("button", { name: "Kontakt", exact: true }).click();
  const dlg = page.getByRole("dialog", { name: "Kontakt hinzufügen" });
  await expect(dlg).toBeVisible();
  await expect(dlg).toHaveAttribute("aria-modal", "true");
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
});

test("Vorlagen: Platzhalter landet im Betreff an der Cursorposition", async ({ page }) => {
  await page.goto("/#vorlagen");
  const subj = page.getByLabel("Betreff", { exact: true }), body = page.getByLabel("Text", { exact: true });
  await expect(subj).not.toHaveValue("");
  const s0 = await subj.inputValue(), b0 = await body.inputValue();
  await subj.click();
  await subj.evaluate((el: HTMLInputElement) => el.setSelectionRange(0, 0));
  await page.locator(".ph", { hasText: "{{firma}}" }).click();
  await expect(subj).toHaveValue(`{{firma}}${s0}`);
  await expect(body).toHaveValue(b0);
  /* nothing is saved; a reload drops the change */
});
