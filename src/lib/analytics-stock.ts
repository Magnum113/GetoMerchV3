import type { Inventory, Warehouse } from "@/lib/types";

export interface StockValueBucket {
  blankValue: number;
  blankQty: number;
  finishedValue: number;
  finishedQty: number;
}

export interface StockValueSummary {
  perWarehouse: Record<string, StockValueBucket>;
  total: StockValueBucket;
}

export function emptyStockValueBucket(): StockValueBucket {
  return { blankValue: 0, blankQty: 0, finishedValue: 0, finishedQty: 0 };
}

export function buildStockValueSummary(
  inventory: Inventory[],
  warehouses: Warehouse[],
): StockValueSummary {
  const perWarehouse: Record<string, StockValueBucket> = {};
  const total = emptyStockValueBucket();

  for (const warehouse of warehouses) {
    perWarehouse[warehouse.id] = emptyStockValueBucket();
  }

  for (const row of inventory) {
    const quantity = Number(row.quantity ?? 0);
    if (quantity <= 0) continue;

    const bucket = perWarehouse[row.warehouse_id] ?? emptyStockValueBucket();
    perWarehouse[row.warehouse_id] = bucket;
    const value = Number(row.product?.cost_price ?? 0) * quantity;

    if (row.product?.is_blank) {
      bucket.blankValue += value;
      bucket.blankQty += quantity;
      total.blankValue += value;
      total.blankQty += quantity;
    } else {
      bucket.finishedValue += value;
      bucket.finishedQty += quantity;
      total.finishedValue += value;
      total.finishedQty += quantity;
    }
  }

  return { perWarehouse, total };
}
