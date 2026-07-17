import "server-only";

import type { PoolClient, QueryResultRow } from "pg";
import { getServerDatabasePool, type DatabaseQueryExecutor } from "@/lib/db/pool";
import { DatabaseBusinessError, DatabaseFaultInjectionError, DatabaseQueryError } from "@/lib/db/errors";

type TransactionOptions = {
  isolationLevel?: "read committed" | "repeatable read" | "serializable";
  readOnly?: boolean;
  maxRetries?: number;
};

export async function withServerDatabaseTransaction<T>(
  operation: (query: DatabaseQueryExecutor) => Promise<T>,
  options: TransactionOptions = {},
) {
  const maxRetries = options.maxRetries ?? 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runTransaction(operation, options);
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableTransactionError(error)) throw error;
      await sleep(25 * 3 ** attempt);
    }
  }
}

async function runTransaction<T>(
  operation: (query: DatabaseQueryExecutor) => Promise<T>,
  options: TransactionOptions,
) {
  const client = await getServerDatabasePool().connect();
  try {
    await client.query("BEGIN");
    await configureTransaction(client, options);
    const result = await operation(async <Row extends QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ) => {
      const queryResult = await client.query<Row>(text, [...values]);
      return { rows: queryResult.rows, rowCount: queryResult.rowCount };
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (
      error instanceof DatabaseQueryError ||
      error instanceof DatabaseBusinessError ||
      error instanceof DatabaseFaultInjectionError
    ) throw error;
    throw new DatabaseQueryError("Database transaction failed", { cause: error });
  } finally {
    client.release();
  }
}

function isRetryableTransactionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === "object" && "code" in current) {
      const code = String((current as { code?: unknown }).code ?? "");
      if (code === "40001" || code === "40P01") return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function configureTransaction(client: PoolClient, options: TransactionOptions) {
  const isolation = options.isolationLevel ?? "read committed";
  const isolationSql = {
    "read committed": "READ COMMITTED",
    "repeatable read": "REPEATABLE READ",
    serializable: "SERIALIZABLE",
  }[isolation];
  const accessMode = options.readOnly ? "READ ONLY" : "READ WRITE";
  await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolationSql} ${accessMode}`);
}
