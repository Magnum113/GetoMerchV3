import "server-only";

import { Pool, type PoolConfig, type QueryResultRow } from "pg";
import { getServerDatabaseUrl } from "@/lib/db/config";
import { DatabaseConfigurationError, DatabaseQueryError } from "@/lib/db/errors";

export type DatabaseQueryResult<T> = {
  rows: T[];
  rowCount: number | null;
};

export type DatabaseQueryExecutor = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: readonly unknown[],
) => Promise<DatabaseQueryResult<T>>;

let pool: Pool | null = null;

export function getServerDatabasePool() {
  if (pool) return pool;

  const connectionString = getServerDatabaseUrl();
  if (!connectionString) {
    throw new DatabaseConfigurationError("GETOMERCH_DATABASE_URL is not configured");
  }

  const config: PoolConfig = {
    connectionString,
    max: readPoolMax(),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 20_000,
    query_timeout: 25_000,
    application_name: process.env.GETOMERCH_DATABASE_APPLICATION_NAME?.trim()
      || "getomerch-admin-server-db",
    ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  };
  pool = new Pool(config);
  pool.on("error", (error) => {
    console.error("[database] idle client error", {
      name: error.name,
      code: "code" in error ? error.code : undefined,
    });
  });
  return pool;
}

export const queryServerDatabase: DatabaseQueryExecutor = async (text, values = []) => {
  try {
    const result = await getServerDatabasePool().query(text, [...values]);
    return { rows: result.rows, rowCount: result.rowCount };
  } catch (error) {
    throw new DatabaseQueryError("Database query failed", { cause: error });
  }
};

export async function closeServerDatabasePool() {
  const current = pool;
  pool = null;
  if (current) await current.end();
}

function readPoolMax() {
  const raw = process.env.GETOMERCH_DATABASE_POOL_MAX?.trim() || "4";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new DatabaseConfigurationError(
      "GETOMERCH_DATABASE_POOL_MAX must be an integer between 1 and 20",
    );
  }
  return value;
}

function shouldUseSsl(connectionString: string) {
  const forced = process.env.GETOMERCH_DATABASE_SSL?.trim().toLowerCase();
  if (["false", "0", "disable"].includes(forced ?? "")) return false;
  if (["true", "1", "require"].includes(forced ?? "")) return true;

  try {
    const url = new URL(connectionString);
    const sslMode = url.searchParams.get("sslmode")?.toLowerCase();
    if (sslMode === "disable") return false;
    if (["require", "verify-full", "verify-ca"].includes(sslMode ?? "")) return true;
    return !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return true;
  }
}
