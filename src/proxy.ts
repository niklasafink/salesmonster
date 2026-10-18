import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, readSession } from "@/lib/session";
import { safeNext } from "@/lib/safe-next";

export async function proxy(req: NextRequest) {
  const uid = await readSession(req.cookies.get(COOKIE)?.value), path = req.nextUrl.pathname;
  if (path === "/login") return uid ? NextResponse.redirect(new URL(safeNext(req.nextUrl.search, req.nextUrl.origin), req.url)) : NextResponse.next();
  if (uid) {
    const res = NextResponse.next();
    /* no bfcache/HTTP cache for the app shell, so Back after logout cannot show it */
    if (path === "/") res.headers.set("Cache-Control", "no-store");
    return res;
  }
  if (path.startsWith("/api/")) return NextResponse.json({ error: "Nicht angemeldet" }, { status: 401 });
  const login = new URL("/login", req.url);
  if (path !== "/") login.searchParams.set("next", path + req.nextUrl.search);
  return NextResponse.redirect(login);
}

/* api/mcp, api/oauth and .well-known authenticate themselves (bearer token or own session check) */
export const config = {
  matcher: ["/((?!api/auth/login|api/cron|api/abmelden|api/integrations/microsoft/callback|api/mcp|api/oauth|.well-known|_next/static|_next/image|icon.svg|favicon.ico|apple-icon|manifest.webmanifest).*)"],
};
