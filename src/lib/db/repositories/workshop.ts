import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { DatabaseQueryError } from "@/lib/db/errors";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import type { CatalogRepository } from "@/lib/db/repositories/catalog";
import type { ProductRepository } from "@/lib/db/repositories/products";
import type {
  DecorationType,
  Design,
  Product,
  WorkshopOrder,
  WorkshopOrderItem,
} from "@/lib/types";

type WorkshopOrderRow = Omit<WorkshopOrder, "workshop" | "items">;
type WorkshopItemRow = {
  id: string;
  order_id: string;
  blank_product_id: string | null;
  design_id: string;
  decoration_type_id: string;
  result_product_id: string | null;
  quantity: number;
  notes: string | null;
  design_version: string | null;
  hoodie_fit: string | null;
  hoodie_fabric: string | null;
};

const ORDER_COLUMNS =
  "id,order_number,workshop_id,status,notes,created_at,sent_at,completed_at,received_at";
const ITEM_COLUMNS =
  "id,order_id,blank_product_id,design_id,decoration_type_id,result_product_id,quantity,notes,design_version,hoodie_fit,hoodie_fabric";

export interface WorkshopRepository {
  list(limit: number): Promise<WorkshopOrder[]>;
  get(id: string): Promise<WorkshopOrder | null>;
}

export class PostgresWorkshopRepository implements WorkshopRepository {
  constructor(
    private readonly query: DatabaseQueryExecutor,
    private readonly catalog: CatalogRepository,
    private readonly products: ProductRepository,
  ) {}

  async list(limit: number) {
    const orders = (
      await this.query<WorkshopOrderRow>(
        `
          SELECT ${ORDER_COLUMNS}
          FROM merch_workshop_orders
          ORDER BY created_at DESC, id DESC
          LIMIT $1
        `,
        [limit],
      )
    ).rows;
    return hydrateWorkshopOrders(orders, await this.listItems(orders.map((row) => row.id)), this.catalog, this.products);
  }

  async get(id: string) {
    const orders = (
      await this.query<WorkshopOrderRow>(
        `SELECT ${ORDER_COLUMNS} FROM merch_workshop_orders WHERE id = $1::uuid LIMIT 1`,
        [id],
      )
    ).rows;
    if (orders.length === 0) return null;
    return (
      await hydrateWorkshopOrders(orders, await this.listItems([id]), this.catalog, this.products)
    )[0] ?? null;
  }

  private async listItems(orderIds: string[]) {
    if (orderIds.length === 0) return [];
    return (
      await this.query<WorkshopItemRow>(
        `
          SELECT ${ITEM_COLUMNS}
          FROM merch_workshop_order_items
          WHERE order_id = ANY($1::uuid[])
          ORDER BY order_id, id
        `,
        [orderIds],
      )
    ).rows;
  }
}

export class SupabaseWorkshopRepository implements WorkshopRepository {
  constructor(
    private readonly client: SupabaseClient,
    private readonly catalog: CatalogRepository,
    private readonly products: ProductRepository,
  ) {}

  async list(limit: number) {
    const { data, error } = await this.client
      .from("merch_workshop_orders")
      .select(ORDER_COLUMNS)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);
    if (error) throw repositoryError(error);
    const orders = (data ?? []) as WorkshopOrderRow[];
    return hydrateWorkshopOrders(orders, await this.listItems(orders.map((row) => row.id)), this.catalog, this.products);
  }

  async get(id: string) {
    const { data, error } = await this.client
      .from("merch_workshop_orders")
      .select(ORDER_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error) throw repositoryError(error);
    if (!data) return null;
    const orders = [data as WorkshopOrderRow];
    return (
      await hydrateWorkshopOrders(orders, await this.listItems([id]), this.catalog, this.products)
    )[0] ?? null;
  }

  private async listItems(orderIds: string[]) {
    if (orderIds.length === 0) return [];
    const { data, error } = await this.client
      .from("merch_workshop_order_items")
      .select(ITEM_COLUMNS)
      .in("order_id", orderIds)
      .order("order_id")
      .order("id");
    if (error) throw repositoryError(error);
    return (data ?? []) as WorkshopItemRow[];
  }
}

async function hydrateWorkshopOrders(
  orders: WorkshopOrderRow[],
  items: WorkshopItemRow[],
  catalog: CatalogRepository,
  products: ProductRepository,
) {
  const productIds = items.flatMap((item) =>
    [item.blank_product_id, item.result_product_id].filter(Boolean) as string[],
  );
  const [productRows, lookups, warehouses] = await Promise.all([
    products.listByIds(productIds),
    catalog.listProductLookups(),
    catalog.listWarehouses(),
  ]);
  const productsById = byId(productRows);
  const designsById = byId(lookups.designs);
  const decorationsById = byId(lookups.decorationTypes);
  const warehousesById = byId(warehouses);
  const itemsByOrder = new Map<string, WorkshopOrderItem[]>();
  for (const item of items) {
    const list = itemsByOrder.get(item.order_id) ?? [];
    list.push(mapItem(item, productsById, designsById, decorationsById));
    itemsByOrder.set(item.order_id, list);
  }
  return orders.map((order) => ({
    ...order,
    workshop: warehousesById.get(order.workshop_id),
    items: itemsByOrder.get(order.id) ?? [],
  }));
}

function mapItem(
  item: WorkshopItemRow,
  products: Map<string, Product>,
  designs: Map<string, Design>,
  decorations: Map<string, DecorationType>,
): WorkshopOrderItem {
  return {
    ...item,
    blank_product: item.blank_product_id ? products.get(item.blank_product_id) : null,
    result_product: item.result_product_id ? products.get(item.result_product_id) ?? null : null,
    design: designs.get(item.design_id),
    decoration_type: decorations.get(item.decoration_type_id),
  };
}

function byId<T extends { id: string }>(rows: T[]) {
  return new Map(rows.map((row) => [row.id, row]));
}

function repositoryError(error: unknown) {
  return new DatabaseQueryError("Supabase repository query failed", { cause: error });
}
