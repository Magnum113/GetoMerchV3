import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { DatabaseQueryError } from "@/lib/db/errors";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import type { CatalogRepository } from "@/lib/db/repositories/catalog";
import type { ProductRepository } from "@/lib/db/repositories/products";
import type { Transaction } from "@/lib/types";

type TransactionRow = Omit<
  Transaction,
  "product" | "design" | "source_design" | "from_warehouse" | "to_warehouse"
>;

const TRANSACTION_COLUMNS =
  "id,type,product_id,design_id,source_design_id,from_warehouse_id,to_warehouse_id,quantity,source_product_id,workshop_order_id,notes,occurred_at,created_at";

export interface TransactionRepository {
  list(limit: number): Promise<Transaction[]>;
}

export class PostgresTransactionRepository implements TransactionRepository {
  constructor(
    private readonly query: DatabaseQueryExecutor,
    private readonly catalog: CatalogRepository,
    private readonly products: ProductRepository,
  ) {}

  async list(limit: number) {
    const rows = (
      await this.query<TransactionRow>(
        `
          SELECT ${TRANSACTION_COLUMNS}
          FROM merch_transactions
          ORDER BY occurred_at DESC, id DESC
          LIMIT $1
        `,
        [limit],
      )
    ).rows;
    return hydrateTransactions(rows, this.catalog, this.products);
  }
}

export class SupabaseTransactionRepository implements TransactionRepository {
  constructor(
    private readonly client: SupabaseClient,
    private readonly catalog: CatalogRepository,
    private readonly products: ProductRepository,
  ) {}

  async list(limit: number) {
    const { data, error } = await this.client
      .from("merch_transactions")
      .select(TRANSACTION_COLUMNS)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);
    if (error) throw new DatabaseQueryError("Supabase repository query failed", { cause: error });
    return hydrateTransactions((data ?? []) as TransactionRow[], this.catalog, this.products);
  }
}

async function hydrateTransactions(
  rows: TransactionRow[],
  catalog: CatalogRepository,
  products: ProductRepository,
) {
  const [productRows, lookups, warehouses] = await Promise.all([
    products.listByIds(rows.map((row) => row.product_id).filter(Boolean) as string[]),
    catalog.listProductLookups(),
    catalog.listWarehouses(),
  ]);
  const productsById = byId(productRows);
  const designsById = byId(lookups.designs);
  const warehousesById = byId(warehouses);
  return rows.map((row) => ({
    ...row,
    product: row.product_id ? productsById.get(row.product_id) ?? null : null,
    design: row.design_id ? designsById.get(row.design_id) ?? null : null,
    source_design: row.source_design_id
      ? designsById.get(row.source_design_id) ?? null
      : null,
    from_warehouse: row.from_warehouse_id
      ? warehousesById.get(row.from_warehouse_id) ?? null
      : null,
    to_warehouse: row.to_warehouse_id
      ? warehousesById.get(row.to_warehouse_id) ?? null
      : null,
  }));
}

function byId<T extends { id: string }>(rows: T[]) {
  return new Map(rows.map((row) => [row.id, row]));
}
