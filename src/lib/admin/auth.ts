import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import {
  getAuthCookieName,
  type AdminSessionPayload,
  verifySessionToken,
} from "@/lib/auth/session";
import { AdminApiError } from "@/lib/admin/http";

export type AdminRouteSession = {
  sub: AdminSessionPayload["sub"] | "internal-service";
  sessionId: string;
};

export async function requireAdminOrService(request: Request): Promise<AdminRouteSession> {
  const configuredToken = process.env.GETOMERCH_INTERNAL_SERVICE_TOKEN?.trim();
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const suppliedToken = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";

  if (configuredToken && suppliedToken && safeEqual(configuredToken, suppliedToken)) {
    return {
      sub: "internal-service",
      sessionId: createHash("sha256").update(suppliedToken).digest("hex").slice(0, 24),
    };
  }

  return requireAdminSession();
}

export async function requireAdminSession(): Promise<AdminRouteSession> {
  const cookieStore = await cookies();
  const token = cookieStore.get(getAuthCookieName())?.value;
  const ok = await verifySessionToken(token, process.env.ADMIN_AUTH_COOKIE_SECRET);

  if (!ok) {
    throw new AdminApiError(401, "unauthorized", "Unauthorized");
  }

  const sessionHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const sessionId = Array.from(new Uint8Array(sessionHash).slice(0, 12))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return { sub: "owner", sessionId };
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
