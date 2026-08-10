import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { DatabaseQueryError } from "@/lib/db/errors";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import type { ProductRepository } from "@/lib/db/repositories/products";
import type { OzonFinanceOperation, Product } from "@/lib/types";

export type FinanceListOptions = {
  limit: number;
  offset: number;
  from?: string;
  to?: string;
  postingNumber?: string;
};

export type FinancePage = {
  rows: OzonFinanceOperation[];
  hasMore: boolean;
};

export type OzonSkuProduct = { ozon_sku: string; product: Product };

type SkuProductRef = { id: string; ozon_sku: string; product_id: string };

const FINANCE_SELECT =
  "id,operation_id,operation_type,operation_type_name,operation_date,posting_number,accruals_for_sale,sale_commission,amount,services,items,synced_at";

export interface FinanceRepository {
  list(options: FinanceListOptions): Promise<FinancePage>;
  listOzonSkuProductMap(): Promise<OzonSkuProduct[]>;
  lastSyncAt(): Promise<string | null>;
}

export class PostgresFinanceRepository implements FinanceRepository {
  constructor(
    private readonly query: DatabaseQueryExecutor,
    private readonly products: ProductRepository,
  ) {}

  async list(options: FinanceListOptions) {
    const result = (
      await this.query<OzonFinanceOperation>(
        `
          SELECT id, operation_id::float8 AS operation_id, operation_type,
                 operation_type_name, operation_date, posting_number,
                 accruals_for_sale::float8 AS accruals_for_sale,
                 sale_commission::float8 AS sale_commission,
                 amount::float8 AS amount, services, items, synced_at
          FROM merch_ozon_finance_operations
          WHERE ($2::timestamptz IS NULL OR operation_date >= $2)
            AND ($3::timestamptz IS NULL OR operation_date < $3)
            AND ($4::text IS NULL OR posting_number = $4)
          ORDER BY operation_date DESC, id DESC
          LIMIT $1 OFFSET $5
        `,
        [
          options.limit + 1,
          options.from ?? null,
          options.to ?? null,
          options.postingNumber ?? null,
          options.offset,
        ],
      )
    ).rows;
    const hasMore = result.length > options.limit;
    return {
      rows: hasMore ? result.slice(0, options.limit) : result,
      hasMore,
    };
  }

  async listOzonSkuProductMap() {
    const refs = (
      await this.query<SkuProductRef>(
        `
          SELECT id, ozon_sku, product_id
          FROM merch_ozon_order_items
          WHERE source_active = true
            AND ozon_sku IS NOT NULL
            AND product_id IS NOT NULL
          ORDER BY ozon_sku COLLATE "C", id
        `,
      )
    ).rows;
    return hydrateSkuMap(refs, this.products);
  }

  async lastSyncAt() {
    const result = await this.query<{ synced_at: string }>(
      "SELECT synced_at FROM merch_ozon_finance_operations ORDER BY synced_at DESC, id DESC LIMIT 1",
    );
    return result.rows[0]?.synced_at ?? null;
  }
}

export class SupabaseFinanceRepository implements FinanceRepository {
  constructor(
    private readonly client: SupabaseClient,
    private readonly products: ProductRepository,
  ) {}

  async list(options: FinanceListOptions) {
    let query = this.client
      .from("merch_ozon_finance_operations")
      .select(FINANCE_SELECT)
      .order("operation_date", { ascending: false })
      .order("id", { ascending: false })
      .range(options.offset, options.offset + options.limit);
    if (options.from) query = query.gte("operation_date", options.from);
    if (options.to) query = query.lt("operation_date", options.to);
    if (options.postingNumber) query = query.eq("posting_number", options.postingNumber);
    const { data, error } = await query;
    if (error) throw repositoryError(error);
    const result = (data ?? []) as unknown as OzonFinanceOperation[];
    const hasMore = result.length > options.limit;
    return {
      rows: hasMore ? result.slice(0, options.limit) : result,
      hasMore,
    };
  }

  async listOzonSkuProductMap() {
    const { data, error } = await this.client
      .from("merch_ozon_order_items")
      .select("id,ozon_sku,product_id")
      .not("ozon_sku", "is", null)
      .not("product_id", "is", null)
      .order("ozon_sku")
      .order("id");
    if (error) throw repositoryError(error);
    return hydrateSkuMap((data ?? []) as SkuProductRef[], this.products);
  }

  async lastSyncAt() {
    const { data, error } = await this.client
      .from("merch_ozon_finance_operations")
      .select("synced_at")
      .order("synced_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw repositoryError(error);
    return (data?.synced_at as string | null) ?? null;
  }
}

async function hydrateSkuMap(refs: SkuProductRef[], products: ProductRepository) {
  const productRows = await products.listByIds(refs.map((row) => row.product_id));
  const productsById = new Map(productRows.map((product) => [product.id, product]));
  const seen = new Set<string>();
  const result: OzonSkuProduct[] = [];
  for (const row of refs) {
    const product = productsById.get(row.product_id);
    if (seen.has(row.ozon_sku) || !product) continue;
    seen.add(row.ozon_sku);
    result.push({ ozon_sku: row.ozon_sku, product });
  }
  return result;
}

function repositoryError(error: unknown) {
  return new DatabaseQueryError("Supabase repository query failed", { cause: error });
}
