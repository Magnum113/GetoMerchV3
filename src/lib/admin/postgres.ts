import "server-only";

import { Pool } from "pg";

let pool: Pool | null = null;

export function hasAdminPostgres() {
  return Boolean(process.env.GETOMERCH_SUPABASE_DATABASE_URL?.trim());
}

export async function adminDbQuery<T = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
) {
  const db = getAdminPostgresPool();
  return (await db.query(text, values)) as unknown as { rows: T[]; rowCount: number | null };
}

function getAdminPostgresPool() {
  if (pool) return pool;

  const connectionString = process.env.GETOMERCH_SUPABASE_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("GETOMERCH_SUPABASE_DATABASE_URL is not configured");
  }

  pool = new Pool({
    connectionString,
    max: Number(process.env.GETOMERCH_POSTGRES_POOL_MAX ?? 5),
    maxUses: Number(process.env.GETOMERCH_POSTGRES_POOL_MAX_USES ?? 1),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 20_000,
    query_timeout: 25_000,
    application_name: "getomerch-admin",
    ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });

  pool.on("error", (error) => {
    console.error("[admin-postgres] idle client error", {
      name: error.name,
      message: error.message,
    });
  });

  return pool;
}

function shouldUseSsl(connectionString: string) {
  const forced = process.env.GETOMERCH_POSTGRES_SSL?.trim().toLowerCase();
  if (forced === "false" || forced === "0" || forced === "disable") return false;
  if (forced === "true" || forced === "1" || forced === "require") return true;

  try {
    const url = new URL(connectionString);
    const sslMode = url.searchParams.get("sslmode")?.toLowerCase();
    if (sslMode === "disable") return false;
    if (sslMode === "require" || sslMode === "verify-full" || sslMode === "verify-ca") return true;
    return !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return true;
  }
}
