import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { DatabaseQueryError } from "@/lib/db/errors";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import type { ProductRepository } from "@/lib/db/repositories/products";
import type { OzonOrder, OzonOrderItem, WorkshopOrder } from "@/lib/types";

export type OzonOrderListOptions = {
  limit: number;
  status?: string;
  source?: string;
};

type OzonOrderRow = Omit<OzonOrder, "items" | "workshop_order">;
type OzonOrderItemRow = Omit<OzonOrderItem, "product"> & {
  created_at: string;
  shipped_from_warehouse_id: string | null;
};
type WorkshopOrderRow = Omit<WorkshopOrder, "workshop" | "items">;

const ORDER_SELECT =
  "id,posting_number,order_id,order_number,status,substatus,ozon_created_at,in_process_at,shipment_date,delivery_method,warehouse_name,customer_name,total_price,source,synced_at,shipped_at,shipped_from_warehouse_id,workshop_order_id,notes,created_at";
const ITEM_SELECT =
  "id,order_id,offer_id,ozon_sku,name,quantity,price,product_id,created_at,shipped_from_warehouse_id";
const WORKSHOP_SELECT =
  "id,order_number,workshop_id,status,notes,created_at,sent_at,completed_at,received_at";

export interface OzonOrderRepository {
  list(options: OzonOrderListOptions): Promise<OzonOrder[]>;
}

export class PostgresOzonOrderRepository implements OzonOrderRepository {
  constructor(
    private readonly query: DatabaseQueryExecutor,
    private readonly products: ProductRepository,
  ) {}

  async list(options: OzonOrderListOptions) {
    const orders = (
      await this.query<OzonOrderRow>(
        `
          SELECT
            id, posting_number, order_id::float8 AS order_id, order_number,
            status, substatus, ozon_created_at, in_process_at, shipment_date,
            delivery_method, warehouse_name, customer_name,
            total_price::float8 AS total_price, source, synced_at, shipped_at,
            shipped_from_warehouse_id, workshop_order_id, notes, created_at
          FROM merch_ozon_orders
          WHERE ($2::text IS NULL OR status = $2)
            AND ($3::text IS NULL OR source = $3)
          ORDER BY in_process_at DESC NULLS LAST, created_at DESC, id DESC
          LIMIT $1
        `,
        [options.limit, options.status ?? null, options.source ?? null],
      )
    ).rows;
    const [items, workshopOrders] = await Promise.all([
      this.listItems(orders.map((order) => order.id)),
      this.listWorkshopOrders(
        orders.map((order) => order.workshop_order_id).filter(Boolean) as string[],
      ),
    ]);
    return hydrateOrders(orders, items, workshopOrders, this.products);
  }

  private async listItems(orderIds: string[]) {
    if (orderIds.length === 0) return [];
    return (
      await this.query<OzonOrderItemRow>(
        `
          SELECT id, order_id, offer_id, ozon_sku, name, quantity,
                 price::float8 AS price, product_id, created_at,
                 shipped_from_warehouse_id
          FROM merch_ozon_order_items
          WHERE order_id = ANY($1::uuid[])
          ORDER BY order_id, id
        `,
        [orderIds],
      )
    ).rows;
  }

  private async listWorkshopOrders(ids: string[]) {
    if (ids.length === 0) return [];
    return (
      await this.query<WorkshopOrderRow>(
        `SELECT ${WORKSHOP_SELECT} FROM merch_workshop_orders WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [ids],
      )
    ).rows;
  }
}

export class SupabaseOzonOrderRepository implements OzonOrderRepository {
  constructor(
    private readonly client: SupabaseClient,
    private readonly products: ProductRepository,
  ) {}

  async list(options: OzonOrderListOptions) {
    let query = this.client
      .from("merch_ozon_orders")
      .select(ORDER_SELECT)
      .order("in_process_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(options.limit);
    if (options.status) query = query.eq("status", options.status);
    if (options.source) query = query.eq("source", options.source);
    const { data, error } = await query;
    if (error) throw repositoryError(error);
    const orders = (data ?? []) as OzonOrderRow[];
    const [items, workshopOrders] = await Promise.all([
      this.listItems(orders.map((order) => order.id)),
      this.listWorkshopOrders(
        orders.map((order) => order.workshop_order_id).filter(Boolean) as string[],
      ),
    ]);
    return hydrateOrders(orders, items, workshopOrders, this.products);
  }

  private async listItems(orderIds: string[]) {
    if (orderIds.length === 0) return [];
    const { data, error } = await this.client
      .from("merch_ozon_order_items")
      .select(ITEM_SELECT)
      .in("order_id", orderIds)
      .order("order_id")
      .order("id");
    if (error) throw repositoryError(error);
    return (data ?? []) as OzonOrderItemRow[];
  }

  private async listWorkshopOrders(ids: string[]) {
    if (ids.length === 0) return [];
    const { data, error } = await this.client
      .from("merch_workshop_orders")
      .select(WORKSHOP_SELECT)
      .in("id", ids)
      .order("id");
    if (error) throw repositoryError(error);
    return (data ?? []) as WorkshopOrderRow[];
  }
}

async function hydrateOrders(
  orders: OzonOrderRow[],
  items: OzonOrderItemRow[],
  workshopOrders: WorkshopOrderRow[],
  products: ProductRepository,
) {
  const productRows = await products.listByIds(
    items.map((item) => item.product_id).filter(Boolean) as string[],
  );
  const productsById = byId(productRows);
  const workshopsById = byId(workshopOrders);
  const itemsByOrder = new Map<string, Array<OzonOrderItemRow & { product: typeof productRows[number] | null }>>();
  for (const item of items) {
    const list = itemsByOrder.get(item.order_id) ?? [];
    list.push({
      ...item,
      product: item.product_id ? productsById.get(item.product_id) ?? null : null,
    });
    itemsByOrder.set(item.order_id, list);
  }
  return orders.map((order) => ({
    ...order,
    items: itemsByOrder.get(order.id) ?? [],
    workshop_order: order.workshop_order_id
      ? workshopsById.get(order.workshop_order_id) ?? null
      : null,
  }));
}

function byId<T extends { id: string }>(rows: T[]) {
  return new Map(rows.map((row) => [row.id, row]));
}

function repositoryError(error: unknown) {
  return new DatabaseQueryError("Supabase repository query failed", { cause: error });
}
