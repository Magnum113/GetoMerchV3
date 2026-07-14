import { NextRequest, NextResponse } from "next/server";
import { getAuthCookieName, verifySessionToken } from "@/lib/auth/session";

const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth/",
  "/_next/",
];

const PUBLIC_PATHS = new Set([
  "/favicon.ico",
  "/icon.svg",
  "/robots.txt",
  "/sitemap.xml",
]);

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const token = request.cookies.get(getAuthCookieName())?.value;
  const ok = await verifySessionToken(token, process.env.ADMIN_AUTH_COOKIE_SECRET);
  if (ok) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  loginUrl.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};

function isPublicPath(pathname: string) {
  return PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
