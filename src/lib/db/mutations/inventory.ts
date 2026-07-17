import "server-only";

import { DatabaseBusinessError } from "@/lib/db/errors";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";

export type InventoryDelta = {
  productId: string;
  warehouseId: string;
  delta: number;
};

export type PrintInventoryDelta = {
  designId: string;
  warehouseId: string;
  delta: number;
};

export type InventoryChange = {
  productId: string;
  warehouseId: string;
  before: number;
  after: number;
};

export type PrintInventoryChange = {
  designId: string;
  warehouseId: string;
  before: number;
  after: number;
};

type InventoryRow = {
  product_id: string;
  warehouse_id: string;
  quantity: number;
};

type PrintInventoryRow = {
  design_id: string;
  warehouse_id: string;
  quantity: number;
};

export async function applyInventoryDeltas(
  query: DatabaseQueryExecutor,
  deltas: InventoryDelta[],
): Promise<InventoryChange[]> {
  const normalized = aggregateInventoryDeltas(deltas);
  if (normalized.length === 0) return [];
  const keys = normalized.map(({ productId, warehouseId }) => ({ productId, warehouseId }));
  const rows = await lockInventoryRows(query, keys);
  const quantities = new Map(rows.map((row) => [inventoryKey(row.product_id, row.warehouse_id), row.quantity]));
  const changes = normalized.map((delta) => {
    const before = quantities.get(inventoryKey(delta.productId, delta.warehouseId)) ?? 0;
    const after = before + delta.delta;
    if (after < 0) {
      throw new DatabaseBusinessError(
        "insufficient_inventory",
        `Недостаточно остатка на складе: есть ${before}, требуется ${Math.abs(delta.delta)}.`,
      );
    }
    return { productId: delta.productId, warehouseId: delta.warehouseId, before, after };
  });

  await query(
    `
      WITH changes AS (
        SELECT product_id, warehouse_id, quantity
        FROM jsonb_to_recordset($1::jsonb) AS x(
          product_id uuid,
          warehouse_id uuid,
          quantity integer
        )
      )
      UPDATE merch_inventory inventory
      SET quantity = changes.quantity
      FROM changes
      WHERE inventory.product_id = changes.product_id
        AND inventory.warehouse_id = changes.warehouse_id
    `,
    [JSON.stringify(changes.map((change) => ({
      product_id: change.productId,
      warehouse_id: change.warehouseId,
      quantity: change.after,
    })))],
  );
  return changes;
}

export async function lockInventoryRows(
  query: DatabaseQueryExecutor,
  keys: Array<{ productId: string; warehouseId: string }>,
) {
  const normalized = uniqueInventoryKeys(keys);
  if (normalized.length === 0) return [];
  const json = JSON.stringify(normalized.map((key) => ({
    product_id: key.productId,
    warehouse_id: key.warehouseId,
  })));
  await query(
    `
      INSERT INTO merch_inventory (product_id, warehouse_id, quantity)
      SELECT product_id, warehouse_id, 0
      FROM jsonb_to_recordset($1::jsonb) AS x(product_id uuid, warehouse_id uuid)
      ON CONFLICT (product_id, warehouse_id) DO NOTHING
    `,
    [json],
  );
  return (
    await query<InventoryRow>(
      `
        WITH wanted AS (
          SELECT product_id, warehouse_id
          FROM jsonb_to_recordset($1::jsonb) AS x(product_id uuid, warehouse_id uuid)
        )
        SELECT inventory.product_id, inventory.warehouse_id, inventory.quantity
        FROM merch_inventory inventory
        JOIN wanted USING (product_id, warehouse_id)
        ORDER BY inventory.product_id, inventory.warehouse_id
        FOR UPDATE OF inventory
      `,
      [json],
    )
  ).rows;
}

export async function applyPrintInventoryDeltas(
  query: DatabaseQueryExecutor,
  deltas: PrintInventoryDelta[],
): Promise<PrintInventoryChange[]> {
  const normalized = aggregatePrintDeltas(deltas);
  if (normalized.length === 0) return [];
  const json = JSON.stringify(normalized.map(({ designId, warehouseId }) => ({
    design_id: designId,
    warehouse_id: warehouseId,
  })));
  await query(
    `
      INSERT INTO merch_print_inventory (design_id, warehouse_id, quantity)
      SELECT design_id, warehouse_id, 0
      FROM jsonb_to_recordset($1::jsonb) AS x(design_id uuid, warehouse_id uuid)
      ON CONFLICT (design_id, warehouse_id) DO NOTHING
    `,
    [json],
  );
  const rows = (
    await query<PrintInventoryRow>(
      `
        WITH wanted AS (
          SELECT design_id, warehouse_id
          FROM jsonb_to_recordset($1::jsonb) AS x(design_id uuid, warehouse_id uuid)
        )
        SELECT inventory.design_id, inventory.warehouse_id, inventory.quantity
        FROM merch_print_inventory inventory
        JOIN wanted USING (design_id, warehouse_id)
        ORDER BY inventory.design_id, inventory.warehouse_id
        FOR UPDATE OF inventory
      `,
      [json],
    )
  ).rows;
  const quantities = new Map(rows.map((row) => [printKey(row.design_id, row.warehouse_id), row.quantity]));
  const changes = normalized.map((delta) => {
    const before = quantities.get(printKey(delta.designId, delta.warehouseId)) ?? 0;
    const after = before + delta.delta;
    if (after < 0) {
      throw new DatabaseBusinessError(
        "insufficient_print_inventory",
        `Недостаточно принтов на складе: есть ${before}, требуется ${Math.abs(delta.delta)}.`,
      );
    }
    return { designId: delta.designId, warehouseId: delta.warehouseId, before, after };
  });
  await query(
    `
      WITH changes AS (
        SELECT design_id, warehouse_id, quantity
        FROM jsonb_to_recordset($1::jsonb) AS x(
          design_id uuid,
          warehouse_id uuid,
          quantity integer
        )
      )
      UPDATE merch_print_inventory inventory
      SET quantity = changes.quantity, updated_at = clock_timestamp()
      FROM changes
      WHERE inventory.design_id = changes.design_id
        AND inventory.warehouse_id = changes.warehouse_id
    `,
    [JSON.stringify(changes.map((change) => ({
      design_id: change.designId,
      warehouse_id: change.warehouseId,
      quantity: change.after,
    })))],
  );
  return changes;
}

export async function insertMovement(
  query: DatabaseQueryExecutor,
  movement: {
    type: "receive" | "transfer" | "sale" | "production" | "adjustment" | "writeoff";
    productId?: string | null;
    designId?: string | null;
    sourceDesignId?: string | null;
    fromWarehouseId?: string | null;
    toWarehouseId?: string | null;
    quantity: number;
    sourceProductId?: string | null;
    workshopOrderId?: string | null;
    notes?: string | null;
  },
) {
  const result = await query<{ id: string }>(
    `
      INSERT INTO merch_transactions (
        type,
        product_id,
        design_id,
        source_design_id,
        from_warehouse_id,
        to_warehouse_id,
        quantity,
        source_product_id,
        workshop_order_id,
        notes
      )
      VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8::uuid, $9::uuid, $10)
      RETURNING id
    `,
    [
      movement.type,
      movement.productId ?? null,
      movement.designId ?? null,
      movement.sourceDesignId ?? null,
      movement.fromWarehouseId ?? null,
      movement.toWarehouseId ?? null,
      movement.quantity,
      movement.sourceProductId ?? null,
      movement.workshopOrderId ?? null,
      movement.notes ?? null,
    ],
  );
  return result.rows[0]?.id;
}

function aggregateInventoryDeltas(deltas: InventoryDelta[]) {
  const values = new Map<string, InventoryDelta>();
  for (const delta of deltas) {
    const key = inventoryKey(delta.productId, delta.warehouseId);
    const current = values.get(key);
    values.set(key, current ? { ...current, delta: current.delta + delta.delta } : { ...delta });
  }
  return [...values.values()]
    .filter((delta) => delta.delta !== 0)
    .sort((left, right) => inventoryKey(left.productId, left.warehouseId).localeCompare(inventoryKey(right.productId, right.warehouseId)));
}

function aggregatePrintDeltas(deltas: PrintInventoryDelta[]) {
  const values = new Map<string, PrintInventoryDelta>();
  for (const delta of deltas) {
    const key = printKey(delta.designId, delta.warehouseId);
    const current = values.get(key);
    values.set(key, current ? { ...current, delta: current.delta + delta.delta } : { ...delta });
  }
  return [...values.values()]
    .filter((delta) => delta.delta !== 0)
    .sort((left, right) => printKey(left.designId, left.warehouseId).localeCompare(printKey(right.designId, right.warehouseId)));
}

function uniqueInventoryKeys(keys: Array<{ productId: string; warehouseId: string }>) {
  return [...new Map(keys.map((key) => [inventoryKey(key.productId, key.warehouseId), key])).values()]
    .sort((left, right) => inventoryKey(left.productId, left.warehouseId).localeCompare(inventoryKey(right.productId, right.warehouseId)));
}

export function inventoryKey(productId: string, warehouseId: string) {
  return `${productId}:${warehouseId}`;
}

function printKey(designId: string, warehouseId: string) {
  return `${designId}:${warehouseId}`;
}
