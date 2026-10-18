import { expect, test, type APIRequestContext } from "@playwright/test";

/* Only the QA tenant is written to. Probes against other tenants are GETs, or requests with ids that cannot exist ("abc"). */
const Q = "qa-testfirma";
const OTHER = ["vh", "conformis-grc", "chetti"];
const raw = { "content-type": "application/json" };
/* a Buffer goes out byte for byte, a string would be JSON-encoded by Playwright */
const bytes = (s: string) => Buffer.from(s);

const tplId = async (request: APIRequestContext) => ((await (await request.get(`/api/state?t=${Q}`)).json()).templates as { id: number }[])[0].id;
const is4xx = (s: number) => s >= 400 && s < 500;

for (const [method, path] of [["POST", "/api/leads"], ["POST", "/api/leads/parse"], ["POST", "/api/setup"], ["PATCH", `/api/tenants/${Q}`], ["PATCH", "/api/leads/abc"]] as const) {
  test(`kaputtes JSON ${method} ${path} liefert 4xx`, async ({ request }) => {
    const r = await request.fetch(path, { method, headers: raw, data: bytes("{kaputt") });
    expect(is4xx(r.status()), `Status ${r.status()}`).toBe(true);
  });
}

test("kaputtes JSON PUT /api/templates/<QA> liefert 4xx", async ({ request }) => {
  const r = await request.fetch(`/api/templates/${await tplId(request)}`, { method: "PUT", headers: raw, data: bytes("{kaputt") });
  expect(is4xx(r.status()), `Status ${r.status()}`).toBe(true);
});

test("fehlende Felder liefern 400", async ({ request }) => {
  const cases: [string, string, unknown, string][] = [
    ["POST", "/api/leads", { t: Q }, "Keine Zeilen"],
    ["POST", "/api/leads", { lead: { company: "x" } }, "Mandant fehlt"],
    ["POST", "/api/leads", { t: Q, lead: {} }, "Firma fehlt"],
    ["POST", "/api/leads", { t: Q, lead: { company: "   " } }, "Firma fehlt"],
    ["POST", "/api/leads/parse", { t: Q }, "Keine Daten"],
    ["POST", "/api/setup", { t: Q }, "Unbekannte Aktion"],
    ["PATCH", "/api/companies/abc", {}, "Unbekannte Einstellung"],
    ["PATCH", "/api/invoices/abc", {}, "Unbekannter Status"],
  ];
  for (const [method, path, data, error] of cases) {
    const r = await request.fetch(path, { method, data });
    expect(r.status(), `${method} ${path} ${JSON.stringify(data)}`).toBe(400);
    expect((await r.json()).error).toBe(error);
  }
});

test("falsche Typen beim Mandanten liefern 404", async ({ request }) => {
  for (const t of [123, [Q], { slug: Q }, null]) {
    const r = await request.post("/api/leads", { data: { t, lead: { company: "nie angelegt" } } });
    expect(is4xx(r.status()), `t=${JSON.stringify(t)}: ${r.status()}`).toBe(true);
  }
});

test("Firma als Zahl liefert 400", async ({ request }) => {
  const r = await request.post("/api/leads", { data: { t: Q, lead: { company: 123 } } });
  expect(r.status()).toBe(400);
});

test("Import mit falschen Zeilen liefert 4xx", async ({ request }) => {
  for (const rows of ["abc", [{}], [{ co: 5 }]]) {
    const r = await request.post("/api/leads", { data: { t: Q, rows } });
    expect(is4xx(r.status()), `rows=${JSON.stringify(rows)}: ${r.status()}`).toBe(true);
  }
});

test("Erkennen mit Text als Zahl oder Liste liefert 4xx", async ({ request }) => {
  for (const text of [42, ["a"], { a: 1 }]) {
    const r = await request.post("/api/leads/parse", { data: { t: Q, text } });
    expect(is4xx(r.status()), `text=${JSON.stringify(text)}: ${r.status()}`).toBe(true);
  }
});

test("nicht numerische IDs liefern 4xx", async ({ request }) => {
  for (const [method, path] of [["PATCH", "/api/leads/abc"], ["DELETE", "/api/leads/abc"], ["PUT", "/api/templates/abc"], ["GET", "/api/invoices/abc/file"]]) {
    const r = await request.fetch(path, { method, data: method === "GET" || method === "DELETE" ? undefined : { status: "neu" } });
    expect(is4xx(r.status()), `${method} ${path}: ${r.status()}`).toBe(true);
  }
});

test("Fehlermeldungen verraten kein SQL", async ({ request }) => {
  const r = await request.get("/api/invoices/abc/file");
  expect(await r.text()).not.toMatch(/Failed query|select "|params:/);
});

test("Vorlage mit falschem Typ für aktiv liefert 4xx", async ({ request }) => {
  const r = await request.put(`/api/templates/${await tplId(request)}`, { data: { active: "nein" } });
  expect(is4xx(r.status()), `Status ${r.status()}`).toBe(true);
});

test("Mandant mit Body null liefert 4xx", async ({ request }) => {
  const r = await request.fetch(`/api/tenants/${Q}`, { method: "PATCH", headers: raw, data: bytes("null") });
  expect(is4xx(r.status()), `Status ${r.status()}`).toBe(true);
});

test("Mandant ohne bekannte Felder liefert keinen 500", async ({ request }) => {
  const r = await request.patch(`/api/tenants/${Q}`, { data: { unbekannt: 1 } });
  expect(r.status(), (await r.text()).slice(0, 100)).toBeLessThan(500);
});

test("Vorlage mit JSON-String als Body liefert 4xx", async ({ request }) => {
  const r = await request.fetch(`/api/templates/${await tplId(request)}`, { method: "PUT", headers: raw, data: bytes('"text"') });
  expect(is4xx(r.status()), `Status ${r.status()}`).toBe(true);
});

test("Einrichtung starten ohne KI liefert 4xx mit Meldung", async ({ request }) => {
  const s = await (await request.get(`/api/setup?t=${Q}`)).json();
  test.skip(s.ai, "QA hat eine KI verbunden");
  const r = await request.post("/api/setup", { data: { t: Q, action: "start" } });
  expect((await r.json()).error).toContain("Keine KI verbunden");
  expect(is4xx(r.status()), `Status ${r.status()}`).toBe(true);
});

test("riesige Firma wird gekürzt, kein 5xx", async ({ request }) => {
  const tag = `QA-${Date.now()}`;
  const r = await request.post("/api/leads", { data: { t: Q, lead: { company: `${tag} ${"x".repeat(200_000)}`, note: "y".repeat(100_000) } } });
  try {
    expect(r.status()).toBeLessThan(500);
  } finally {
    const rows = (await (await request.get(`/api/leads?t=${Q}`)).json()).rows as { id: number; company: string; note: string }[];
    const mine = rows.filter(l => l.company.includes(tag));
    for (const l of mine) await request.delete(`/api/leads/${l.id}`);
    if (r.ok()) {
      expect(mine).toHaveLength(1);
      expect(mine[0].company.length).toBeLessThanOrEqual(500);
      expect(mine[0].note.length).toBeLessThanOrEqual(4000);
    }
  }
});

test("riesiger Import-Text ohne Treffer, kein 5xx", async ({ request }) => {
  const r = await request.post("/api/leads/parse", { data: { t: Q, text: "kleinbuchstaben ohne firma\n".repeat(20_000) } });
  expect(r.status()).toBe(200);
  expect((await r.json()).rows).toEqual([]);
});

test("fremde Mandanten: Listen nur mit 404", async ({ request }) => {
  for (const slug of OTHER) for (const path of [`/api/leads?t=${slug}`, `/api/invoices?t=${slug}`, `/api/customers?t=${slug}`, `/api/setup?t=${slug}`, `/api/stats?t=${slug}`, `/api/tenants/${slug}/icon`]) {
    const r = await request.get(path);
    expect(r.status(), path).toBe(404);
    expect(await r.text(), path).not.toMatch(/"rows"|"setup"|Vergabehero/);
  }
});

test("fremde Mandanten: /api/state fällt auf QA zurück", async ({ request }) => {
  for (const slug of OTHER) {
    const j = await (await request.get(`/api/state?t=${slug}`)).json();
    expect(j.tenant.slug).toBe(Q);
    expect(j.tenants.map((t: { slug: string }) => t.slug)).toEqual([Q]);
  }
});

test("fremde IDs: GET liefert keine Daten", async ({ request }) => {
  const own = new Set(((await (await request.get(`/api/leads?t=${Q}`)).json()).rows as { id: number }[]).map(l => l.id));
  for (const id of [1, 2, 3, 10, 100, 200].filter(id => !own.has(id))) {
    for (const path of [`/api/leads/${id}`, `/api/invoices/${id}`]) {
      const r = await request.get(path);
      expect(r.ok(), path).toBe(false);
      expect(await r.text(), path).not.toMatch(/"company"|"tenantId"|"customer"/);
    }
    const f = await request.get(`/api/invoices/${id}/file`);
    expect(f.status(), `/api/invoices/${id}/file`).toBe(404);
    expect(f.headers()["content-disposition"]).toBeUndefined();
  }
});
