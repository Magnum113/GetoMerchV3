import "server-only";

import { queryServerDatabase } from "@/lib/db/pool";
import { withServerDatabaseTransaction } from "@/lib/db/transaction";
import type { JobExecutionContext } from "@/lib/jobs/execution";
import { ozonPost } from "@/lib/ozon/client";

const PAGE_SIZE = 1000;
const MAX_PAGES_GUARD = 10_000;

type FinanceOperation = {
  operation_id: number;
  operation_type: string;
  operation_type_name?: string;
  operation_date: string;
  accruals_for_sale?: number;
  sale_commission?: number;
  amount: number;
  posting?: { posting_number?: string };
  items?: Array<Record<string, unknown>>;
  services?: Array<{ name: string; price: number }>;
};

export type FinanceSyncPayload = {
  from?: string;
  to?: string;
  dryRun?: boolean;
};

export async function executeFinanceSync(context: JobExecutionContext) {
  const payload = context.job.payload as FinanceSyncPayload;
  const to = parseDate(payload.to, new Date(Date.now() + 86_400_000)).toISOString();
  const from = parseDate(payload.from, new Date(Date.now() - 365 * 86_400_000)).toISOString();
  if (new Date(from) >= new Date(to)) throw new Error("Finance sync range is empty");
  const dryRun = payload.dryRun === true;
  const startedAt = Date.now();
  const windows = monthlyWindows(from, to);
  const operationsById = new Map<number, FinanceOperation>();

  await context.report({ phase: "fetch", from, to, windows: windows.length, fetched: 0 }, "fetch_started");
  for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
    assertNotCancelled(context.signal);
    const windowOperations = await fetchWindow(windows[windowIndex], context, windowIndex + 1, windows.length);
    for (const operation of windowOperations) {
      operationsById.set(Number(operation.operation_id), operation);
    }
    await context.report({
      phase: "fetch",
      from,
      to,
      windows: windows.length,
      window: windowIndex + 1,
      fetched: operationsById.size,
    });
  }

  const operations = Array.from(operationsById.values());
  if (dryRun || operations.length === 0) {
    return {
      dryRun,
      fetched: operations.length,
      created: 0,
      updated: 0,
      from,
      to,
      durationMs: Date.now() - startedAt,
    };
  }

  const existingIds = new Set<number>();
  for (const ids of chunk(operations.map((operation) => Number(operation.operation_id)), 1000)) {
    const existing = await queryServerDatabase<{ operation_id: string | number }>(
      "SELECT operation_id FROM merch_ozon_finance_operations WHERE operation_id = ANY ($1::bigint[])",
      [ids],
    );
    for (const row of existing.rows) existingIds.add(Number(row.operation_id));
  }

  let applied = 0;
  const syncedAt = new Date().toISOString();
  for (const batch of chunk(operations, 500)) {
    assertNotCancelled(context.signal);
    await upsertFinanceBatch(batch, syncedAt);
    applied += batch.length;
    await context.report({
      phase: "apply",
      fetched: operations.length,
      applied,
      created: operations.slice(0, applied).filter((operation) => !existingIds.has(Number(operation.operation_id))).length,
      updated: operations.slice(0, applied).filter((operation) => existingIds.has(Number(operation.operation_id))).length,
    });
  }

  const created = operations.reduce(
    (count, operation) => count + (existingIds.has(Number(operation.operation_id)) ? 0 : 1),
    0,
  );
  return {
    dryRun: false,
    fetched: operations.length,
    created,
    updated: operations.length - created,
    from,
    to,
    durationMs: Date.now() - startedAt,
  };
}

async function fetchWindow(
  window: { from: string; to: string },
  context: JobExecutionContext,
  windowIndex: number,
  windowCount: number,
) {
  const output: FinanceOperation[] = [];
  for (let page = 1; page <= MAX_PAGES_GUARD; page += 1) {
    assertNotCancelled(context.signal);
    const response = await ozonPost<{
      result?: { operations?: FinanceOperation[]; page_count?: number };
    }>("/v3/finance/transaction/list", {
      filter: {
        date: window,
        operation_type: [],
        posting_number: "",
        transaction_type: "all",
      },
      page,
      page_size: PAGE_SIZE,
    }, {
      signal: context.signal,
      onRetry: ({ path, attempt, delayMs, status }) =>
        context.report({ phase: "ozon_retry", path, attempt, delayMs, status }, "ozon_retry"),
    });
    const operations = response.result?.operations ?? [];
    output.push(...operations);
    await context.report({
      phase: "fetch_finance_page",
      window: windowIndex,
      windows: windowCount,
      page,
      windowFetched: output.length,
    });
    const pageCount = Number(response.result?.page_count ?? 0);
    if (pageCount > 0 ? page >= pageCount : operations.length < PAGE_SIZE) return output;
  }
  throw new Error("Finance pagination exceeded safety guard");
}

async function upsertFinanceBatch(operations: FinanceOperation[], syncedAt: string) {
  const payload = operations.map((operation) => ({
    operation_id: Number(operation.operation_id),
    operation_type: String(operation.operation_type),
    operation_type_name: operation.operation_type_name ?? null,
    operation_date: operation.operation_date,
    posting_number: operation.posting?.posting_number ?? null,
    accruals_for_sale: operation.accruals_for_sale == null ? null : Number(operation.accruals_for_sale),
    sale_commission: operation.sale_commission == null ? null : Number(operation.sale_commission),
    amount: Number(operation.amount),
    services: operation.services ?? null,
    items: operation.items ?? null,
    raw: operation,
    synced_at: syncedAt,
  }));

  await withServerDatabaseTransaction((query) => query(
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
      ON CONFLICT (operation_id) DO UPDATE SET
        operation_type = EXCLUDED.operation_type,
        operation_type_name = EXCLUDED.operation_type_name,
        operation_date = EXCLUDED.operation_date,
        posting_number = EXCLUDED.posting_number,
        accruals_for_sale = EXCLUDED.accruals_for_sale,
        sale_commission = EXCLUDED.sale_commission,
        amount = EXCLUDED.amount,
        services = EXCLUDED.services,
        items = EXCLUDED.items,
        raw = EXCLUDED.raw,
        synced_at = EXCLUDED.synced_at
    `,
    [JSON.stringify(payload)],
  ));
}

function monthlyWindows(from: string, to: string) {
  const windows: Array<{ from: string; to: string }> = [];
  const end = new Date(to);
  let current = new Date(from);
  while (current < end) {
    const next = new Date(current);
    next.setUTCDate(next.getUTCDate() + 28);
    const windowEnd = next > end ? end : next;
    windows.push({ from: current.toISOString(), to: windowEnd.toISOString() });
    current = windowEnd;
  }
  return windows;
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
