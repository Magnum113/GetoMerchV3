import "server-only";

import { assertAdminWritesEnabled } from "@/lib/admin/maintenance";
import { withServerDatabaseTransaction } from "@/lib/db/transaction";
import { upsertOzonFbsFulfillmentProjection } from "@/lib/fulfillment/ozon-projection";

const TERMINAL_STATUSES = [
  "cancelled",
  "delivered",
  "not_accepted",
];

type BackfillOrderRow = {
  id: string;
  posting_number: string;
  order_id: string | null;
  status: string;
  substatus: string | null;
  ozon_created_at: Date | string | null;
  in_process_at: Date | string | null;
  synced_at: Date | string;
};

export async function backfillOzonFulfillmentBatch(options: {
  limit: number;
  activeOnly: boolean;
}) {
  assertAdminWritesEnabled();
  const limit = clampInteger(options.limit, 1, 500);
  return withServerDatabaseTransaction(async (query) => {
    const rows = (
      await query<BackfillOrderRow>(
        `
          SELECT
            id,
            posting_number,
            order_id::text AS order_id,
            status,
            substatus,
            ozon_created_at,
            in_process_at,
            synced_at
          FROM merch_ozon_orders
          WHERE source = 'fbs'
            AND fulfillment_order_id IS NULL
            AND (
              $2::boolean = false
              OR NOT (status = ANY ($3::text[]))
            )
          ORDER BY created_at, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        `,
        [limit, options.activeOnly, TERMINAL_STATUSES],
      )
    ).rows;

    let itemCount = 0;
    let quantityTotal = 0;
    for (const row of rows) {
      const result = await upsertOzonFbsFulfillmentProjection(query, {
        ozonOrderId: row.id,
        postingNumber: row.posting_number,
        externalOrderId: row.order_id,
        status: row.status,
        substatus: row.substatus,
        sourceCreatedAt: iso(row.ozon_created_at) ?? iso(row.in_process_at),
        syncedAt: iso(row.synced_at)!,
      });
      itemCount += result.activeItemCount;
      quantityTotal += result.quantityTotal;
    }

    const remaining = (
      await query<{ count: string }>(
        `
          SELECT count(*)::text AS count
          FROM merch_ozon_orders
          WHERE source = 'fbs'
            AND fulfillment_order_id IS NULL
            AND (
              $1::boolean = false
              OR NOT (status = ANY ($2::text[]))
            )
        `,
        [options.activeOnly, TERMINAL_STATUSES],
      )
    ).rows[0];

    return {
      processedOrders: rows.length,
      processedItems: itemCount,
      quantityTotal,
      remainingOrders: Number(remaining?.count ?? 0),
      activeOnly: options.activeOnly,
    };
  });
}

function iso(value: Date | string | null) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isSafeInteger(value)) throw new Error("Backfill limit must be an integer");
  return Math.max(min, Math.min(max, value));
}
