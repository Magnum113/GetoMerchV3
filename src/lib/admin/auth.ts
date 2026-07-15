import "server-only";

import { cookies } from "next/headers";
import {
  getAuthCookieName,
  type AdminSessionPayload,
  verifySessionToken,
} from "@/lib/auth/session";
import { AdminApiError } from "@/lib/admin/http";

export type AdminRouteSession = Pick<AdminSessionPayload, "sub">;

export async function requireAdminSession(): Promise<AdminRouteSession> {
  const cookieStore = await cookies();
  const token = cookieStore.get(getAuthCookieName())?.value;
  const ok = await verifySessionToken(token, process.env.ADMIN_AUTH_COOKIE_SECRET);

  if (!ok) {
    throw new AdminApiError(401, "unauthorized", "Unauthorized");
  }

  return { sub: "owner" };
}
