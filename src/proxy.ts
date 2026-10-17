import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, readSession } from "@/lib/session";

export async function proxy(req: NextRequest) {
  const uid = await readSession(req.cookies.get(COOKIE)?.value);
  if (uid) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "Nicht angemeldet" }, { status: 401 });
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = {
  matcher: ["/((?!login|api/auth/login|api/cron|api/integrations/microsoft/callback|_next/static|_next/image|icon.svg|apple-icon|manifest.webmanifest).*)"],
};
