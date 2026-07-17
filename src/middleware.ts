import { NextRequest, NextResponse } from "next/server";
import { getAuthCookieName, verifySessionToken } from "@/lib/auth/session";
import { getMaintenanceState } from "@/lib/maintenance";

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

const INTERNAL_SERVICE_PATHS = new Set([
  "/api/ozon/sync-orders",
  "/api/ozon/sync-finance",
  "/api/ozon/sync-prices",
  "/api/ozon/import/preview",
  "/api/ozon/import/apply",
]);

const MAINTENANCE_SAFE_MUTATION_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/logout",
  "/api/admin/rpc",
  "/api/admin/products/blank-matches",
  "/api/komui/preview",
]);

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (maintenanceBlocksRequest(request, pathname)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "maintenance",
          message: "Админка временно работает только для чтения.",
        },
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": "300",
        },
      },
    );
  }
  if (isPublicPath(pathname)) return NextResponse.next();

  const token = request.cookies.get(getAuthCookieName())?.value;
  const ok = await verifySessionToken(token, process.env.ADMIN_AUTH_COOKIE_SECRET);
  if (ok) return NextResponse.next();

  if (await isInternalServiceRequest(request, pathname)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", requestOrigin(request));
  loginUrl.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

function maintenanceBlocksRequest(request: NextRequest, pathname: string) {
  if (!getMaintenanceState().enabled) return false;
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return false;
  return !MAINTENANCE_SAFE_MUTATION_PATHS.has(pathname);
}

async function isInternalServiceRequest(request: NextRequest, pathname: string) {
  if (!INTERNAL_SERVICE_PATHS.has(pathname)) return false;
  const configuredToken = process.env.GETOMERCH_INTERNAL_SERVICE_TOKEN?.trim();
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const suppliedToken = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  if (!configuredToken || !suppliedToken) return false;
  return constantTimeTokenEqual(configuredToken, suppliedToken);
}

async function constantTimeTokenEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
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
