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

  const loginUrl = new URL("/login", requestOrigin(request));
  loginUrl.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};

function isPublicPath(pathname: string) {
  return PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function requestOrigin(request: NextRequest) {
  const proto = firstHeaderValue(request.headers.get("x-forwarded-proto")) || request.nextUrl.protocol.replace(/:$/, "");
  const host =
    firstHeaderValue(request.headers.get("x-forwarded-host")) ||
    firstHeaderValue(request.headers.get("host")) ||
    request.nextUrl.host;
  return `${proto}://${host}`;
}

function firstHeaderValue(value: string | null) {
  return value?.split(",")[0]?.trim() || null;
}
