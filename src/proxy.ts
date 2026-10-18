import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, readSession } from "@/lib/session";

export async function proxy(req: NextRequest) {
  const uid = await readSession(req.cookies.get(COOKIE)?.value), path = req.nextUrl.pathname;
  if (path === "/login") return uid ? NextResponse.redirect(new URL("/", req.url)) : NextResponse.next();
  if (uid) {
    const res = NextResponse.next();
    /* no bfcache/HTTP cache for the app shell, so Back after logout cannot show it */
    if (path === "/") res.headers.set("Cache-Control", "no-store");
    return res;
  }
  if (path.startsWith("/api/")) return NextResponse.json({ error: "Nicht angemeldet" }, { status: 401 });
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = {
  matcher: ["/((?!api/auth/login|api/cron|api/integrations/microsoft/callback|_next/static|_next/image|icon.svg|favicon.ico|apple-icon|manifest.webmanifest).*)"],
};
