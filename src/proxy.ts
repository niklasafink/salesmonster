import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, readSession } from "@/lib/session";

export async function proxy(req: NextRequest) {
  const uid = await readSession(req.cookies.get(COOKIE)?.value);
  if (uid) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "Nicht angemeldet" }, { status: 401 });
  const login = new URL("/login", req.url);
  if (req.nextUrl.pathname !== "/") login.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(login);
}

/* api/mcp, api/oauth and .well-known authenticate themselves (bearer token or own session check) */
export const config = {
  matcher: ["/((?!login|api/auth/login|api/cron|api/integrations/microsoft/callback|api/mcp|api/oauth|.well-known|_next/static|_next/image|icon.svg|favicon.ico|apple-icon|manifest.webmanifest).*)"],
};
