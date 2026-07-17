import "server-only";

import { DatabaseConfigurationError } from "@/lib/db/errors";

export type DatabaseSource = "supabase" | "server";

export type DatabaseRuntimeConfig = {
  readSource: DatabaseSource;
  writeSource: DatabaseSource;
  shadowCompare: boolean;
  shadowCompareStrict: boolean;
};

export function getDatabaseRuntimeConfig(): DatabaseRuntimeConfig {
  const readSource = readSourceEnv("GETOMERCH_DB_READ_SOURCE", "supabase");
  const writeSource = readSourceEnv("GETOMERCH_DB_WRITE_SOURCE", "supabase");
  const shadowCompare = readBooleanEnv("GETOMERCH_DB_SHADOW_COMPARE", false);
  const shadowCompareStrict = readBooleanEnv(
    "GETOMERCH_DB_SHADOW_COMPARE_STRICT",
    false,
  );

  if (shadowCompareStrict && !shadowCompare) {
    throw new DatabaseConfigurationError(
      "GETOMERCH_DB_SHADOW_COMPARE_STRICT requires GETOMERCH_DB_SHADOW_COMPARE=true",
    );
  }
  if ((readSource === "server" || writeSource === "server" || shadowCompare) && !getServerDatabaseUrl()) {
    throw new DatabaseConfigurationError(
      "GETOMERCH_DATABASE_URL is required for the server database adapter",
    );
  }

  return { readSource, writeSource, shadowCompare, shadowCompareStrict };
}

export function getServerDatabaseUrl() {
  return process.env.GETOMERCH_DATABASE_URL?.trim() ?? "";
}

function readSourceEnv(name: string, fallback: DatabaseSource): DatabaseSource {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "supabase" || value === "server") return value;
  throw new DatabaseConfigurationError(`${name} must be supabase or server`);
}

function readBooleanEnv(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new DatabaseConfigurationError(`${name} must be true or false`);
}
