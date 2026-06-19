import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, passwordMatches, safeNext, signSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = process.env.SESSION_SECRET;
  const expected = process.env.DASHBOARD_PASSWORD;

  const form = await req.formData();
  const provided = String(form.get("password") ?? "");
  const next = safeNext(typeof form.get("next") === "string" ? (form.get("next") as string) : null);

  // Nicht konfiguriert → niemand kommt rein (fail-closed). Bewusst kein Detail an den Client.
  if (!secret || !expected) {
    return redirect(req, "/login", { error: "1", next });
  }

  if (!provided || !(await passwordMatches(secret, provided, expected))) {
    return redirect(req, "/login", { error: "1", next });
  }

  const token = await signSession(secret);
  const res = redirect(req, next);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}

function redirect(req: NextRequest, pathname: string, params?: Record<string, string>): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // 303: POST → GET nach dem Redirect.
  return NextResponse.redirect(url, 303);
}
