import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";

// Passwort-Gate: schützt das Dashboard. Die Landingpage (/), /login, /api/* und
// statische Assets sind NICHT im Matcher → bleiben öffentlich.
//
// Fail-closed in Produktion: ist das Gate nicht konfiguriert (SESSION_SECRET /
// DASHBOARD_PASSWORD fehlen), kommt niemand ins Dashboard. Lokal (NODE_ENV !=
// production) wird ohne Konfiguration durchgelassen, damit `next dev` nicht aussperrt.

export async function middleware(req: NextRequest) {
  const secret = process.env.SESSION_SECRET;
  const configured = !!secret && !!process.env.DASHBOARD_PASSWORD;

  if (!configured) {
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    return redirectToLogin(req); // prod ohne Konfig → dicht
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySession(secret, token)) return NextResponse.next();

  return redirectToLogin(req);
}

function redirectToLogin(req: NextRequest): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  // Zielpfad merken, damit nach dem Login dorthin zurückgesprungen wird.
  url.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  // Nur die Dashboard-Routen. `:path*` lässt das Segment optional → matcht auch
  // den exakten Pfad (z. B. /articles selbst, nicht nur /articles/...).
  matcher: ["/articles/:path*", "/edits/:path*", "/echoes/:path*"],
};
