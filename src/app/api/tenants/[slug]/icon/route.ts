import { HttpError, route, tenantBySlug } from "@/lib/api";

type Ctx = { params: Promise<{ slug: string }> };

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

async function get(url: string) {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(5000) });
    return r.ok ? r : null;
  } catch { return null; }
}

async function image(url: string) {
  const r = await get(url);
  const type = r?.headers.get("content-type") || "";
  if (!r || !/^image\//.test(type)) return null;
  const buf = await r.arrayBuffer();
  return buf.byteLength > 0 ? { buf, type } : null;
}

/* Icon links on the homepage, largest first */
async function linked(domain: string) {
  const r = await get(`https://${domain}`);
  if (!r) return [];
  const html = (await r.text()).slice(0, 200_000), base = r.url;
  const out: { href: string; size: number }[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = /rel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1].toLowerCase() || "";
    const href = /href\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (!href || !/\b(icon|apple-touch-icon)\b/.test(rel) || rel.includes("mask")) continue;
    const size = /\.svg(\?|$)/i.test(href) ? 1000 : Number(/sizes\s*=\s*["']?(\d+)/i.exec(tag)?.[1]) || (rel.includes("apple") ? 180 : 32);
    try { out.push({ href: new URL(href.replace(/&amp;/g, "&"), base).href, size }); } catch { }
  }
  return out.sort((a, b) => b.size - a.size).map(x => x.href);
}

/* The tenant's website icon for the sidebar; 404 lets the client keep the initials */
export const GET = route<Ctx>(async (_req, { params }, me) => {
  const { domain } = await tenantBySlug((await params).slug, me);
  if (!domain) throw new HttpError(404, "Keine Domain");
  const tries = [...await linked(domain), `https://${domain}/favicon.ico`, `https://www.google.com/s2/favicons?domain=${domain}&sz=128`];
  for (const url of tries) {
    const img = await image(url);
    if (img) return new Response(img.buf, { headers: { "content-type": img.type, "cache-control": "private, max-age=604800", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff" } });
  }
  throw new HttpError(404, "Kein Icon");
});
