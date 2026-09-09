import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import { withServerDatabaseTransaction } from "@/lib/db/transaction";
import type { JobExecutionContext } from "@/lib/jobs/execution";
import {
  fetchFinanceAccrualRange,
  type FinanceOperation,
} from "@/lib/ozon/finance-accruals";

// The legacy transaction endpoint last synced successfully on 2026-09-07.
// Re-fetch that day to include late accruals, but preserve older audited history.
const FINANCE_ACCRUAL_CUTOVER = new Date("2026-09-07T00:00:00.000Z");

export type FinanceSyncPayload = {
  from?: string;
  to?: string;
  dryRun?: boolean;
};

export async function executeFinanceSync(context: JobExecutionContext) {
  const payload = context.job.payload as FinanceSyncPayload;
  const to = parseDate(payload.to, new Date()).toISOString();
  const requestedFrom = parseDate(payload.from, new Date(Date.now() - 365 * 86_400_000));
  if (requestedFrom >= new Date(to)) throw new Error("Finance sync range is empty");
  const from = new Date(Math.max(requestedFrom.getTime(), FINANCE_ACCRUAL_CUTOVER.getTime())).toISOString();
  const dryRun = payload.dryRun === true;
  const startedAt = Date.now();
  if (new Date(from) >= new Date(to)) {
    return {
      dryRun,
      fetched: 0,
      created: 0,
      updated: 0,
      replaced: 0,
      from,
      to,
      days: 0,
      durationMs: Date.now() - startedAt,
    };
  }
  const fetched = await fetchFinanceAccrualRange(from, to, {
    signal: context.signal,
    onProgress: context.report,
  });
  const operations = fetched.operations;
  if (dryRun) {
    return {
      dryRun: true,
      fetched: operations.length,
      created: 0,
      updated: 0,
      replaced: 0,
      from: fetched.replaceFrom,
      to: fetched.replaceTo,
      days: fetched.dates.length,
      durationMs: Date.now() - startedAt,
    };
  }

  const syncedAt = new Date().toISOString();
  const applied = await withServerDatabaseTransaction(async (query) => {
    assertNotCancelled(context.signal);
    const existing = await query<{ operation_id: string | number }>(
      `
        SELECT operation_id
        FROM merch_ozon_finance_operations
        WHERE operation_date >= $1::timestamptz
          AND operation_date < $2::timestamptz
      `,
      [fetched.replaceFrom, fetched.replaceTo],
    );
    const existingIds = new Set(existing.rows.map((row) => Number(row.operation_id)));
    const deleted = await query(
      `
        DELETE FROM merch_ozon_finance_operations
        WHERE operation_date >= $1::timestamptz
          AND operation_date < $2::timestamptz
      `,
      [fetched.replaceFrom, fetched.replaceTo],
    );

    let inserted = 0;
    for (const batch of chunk(operations, 500)) {
      assertNotCancelled(context.signal);
      await insertFinanceBatch(query, batch, syncedAt);
      inserted += batch.length;
      await context.report({
        phase: "apply",
        source: "finance_accrual_by_day",
        fetched: operations.length,
        applied: inserted,
        replaced: deleted.rowCount,
      });
    }
    return { existingIds, replaced: deleted.rowCount };
  });

  const created = operations.reduce(
    (count, operation) => count + (applied.existingIds.has(Number(operation.operation_id)) ? 0 : 1),
    0,
  );
  return {
    dryRun: false,
    fetched: operations.length,
    created,
    updated: operations.length - created,
    replaced: applied.replaced,
    from: fetched.replaceFrom,
    to: fetched.replaceTo,
    days: fetched.dates.length,
    durationMs: Date.now() - startedAt,
  };
}

async function insertFinanceBatch(
  query: DatabaseQueryExecutor,
  operations: FinanceOperation[],
  syncedAt: string,
) {
  const payload = operations.map((operation) => ({
    operation_id: Number(operation.operation_id),
    operation_type: String(operation.operation_type),
    operation_type_name: operation.operation_type_name ?? null,
    operation_date: operation.operation_date,
    posting_number: operation.posting?.posting_number || null,
    accruals_for_sale: operation.accruals_for_sale == null ? null : Number(operation.accruals_for_sale),
    sale_commission: operation.sale_commission == null ? null : Number(operation.sale_commission),
    amount: Number(operation.amount),
    services: operation.services ?? null,
    items: operation.items ?? null,
    raw: operation.raw,
    synced_at: syncedAt,
  }));

  await query(
    `
      INSERT INTO merch_ozon_finance_operations (
        operation_id, operation_type, operation_type_name, operation_date,
        posting_number, accruals_for_sale, sale_commission, amount, services,
        items, raw, synced_at
      )
      SELECT
        input.operation_id,
        input.operation_type,
        input.operation_type_name,
        input.operation_date,
        input.posting_number,
        input.accruals_for_sale,
        input.sale_commission,
        input.amount,
        input.services,
        input.items,
        input.raw,
        input.synced_at
      FROM jsonb_to_recordset($1::jsonb) AS input(
        operation_id bigint,
        operation_type text,
        operation_type_name text,
        operation_date timestamptz,
        posting_number text,
        accruals_for_sale numeric,
        sale_commission numeric,
        amount numeric,
        services jsonb,
        items jsonb,
        raw jsonb,
        synced_at timestamptz
      )
    `,
    [JSON.stringify(payload)],
  );
}

function parseDate(value: string | undefined, fallback: Date) {
  const parsed = value ? new Date(value) : fallback;
  if (!Number.isFinite(parsed.getTime())) throw new Error("Invalid finance sync date");
  return parsed;
}

function chunk<T>(items: T[], size: number) {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function assertNotCancelled(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Job cancelled");
}
