import "server-only";

import { createClient } from "@supabase/supabase-js";
import { AdminApiError } from "@/lib/admin/http";

type ServerSupabaseKeyMode = "service_role" | "server" | "anon_fallback";

let cachedMode: ServerSupabaseKeyMode | null = null;

export function getAdminSupabaseClient() {
  const url = readRequiredEnv(
    ["GETOMERCH_SUPABASE_URL", "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"],
    "Supabase URL is not configured",
  );
  const keyInfo = readServerKey();

  return createClient(url, keyInfo.key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      fetch: adminSupabaseFetch,
    },
  });
}

export function getAdminSupabaseKeyMode() {
  if (!cachedMode) readServerKey();
  return cachedMode;
}

function readServerKey() {
  const serviceRoleKey = readEnv([
    "GETOMERCH_SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SERVICE_ROLE",
  ]);
  if (serviceRoleKey) {
    cachedMode = "service_role";
    return { key: serviceRoleKey, mode: cachedMode };
  }

  const serverKey = readEnv(["GETOMERCH_SUPABASE_SERVER_KEY", "SUPABASE_SERVER_KEY"]);
  if (serverKey) {
    cachedMode = "server";
    return { key: serverKey, mode: cachedMode };
  }

  const anonKey = readEnv(["NEXT_PUBLIC_SUPABASE_ANON_KEY"]);
  if (anonKey) {
    cachedMode = "anon_fallback";
    return { key: anonKey, mode: cachedMode };
  }

  throw new AdminApiError(
    500,
    "server_config_error",
    "Supabase server key is not configured",
  );
}

function readRequiredEnv(names: string[], message: string) {
  const value = readEnv(names);
  if (!value) throw new AdminApiError(500, "server_config_error", message);
  return value;
}

function readEnv(names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

function adminSupabaseFetch(input: RequestInfo | URL, init?: RequestInit) {
  return fetch(input, { ...init, cache: "no-store" });
}
