import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { DatabaseQueryError } from "@/lib/db/errors";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import type { ProductRepository } from "@/lib/db/repositories/products";
import type { OzonOrder, OzonOrderItem, WorkshopOrder } from "@/lib/types";

export type OzonOrderListOptions = {
  limit: number;
  offset: number;
  status?: string;
  source?: string;
};

export type OzonOrderPage = {
  rows: OzonOrder[];
  hasMore: boolean;
};

type OzonOrderRow = Omit<OzonOrder, "items" | "workshop_order" | "fulfillment"> & {
  fulfillment_source_channel?: "ozon_fbs" | "komui" | null;
  fulfillment_scheme?: "fbs" | "d2c" | null;
  fulfillment_source_order_key?: string | null;
  fulfillment_source_status?: string | null;
};
type OzonOrderItemRow = Omit<OzonOrderItem, "product" | "fulfillment"> & {
  created_at: string;
  shipped_from_warehouse_id: string | null;
  fulfillment_source_item_key?: string | null;
  fulfillment_quantity?: number | null;
  fulfillment_marking_requirement?: "unknown" | "required" | "not_required" | null;
  fulfillment_exemplar_flow_available?: boolean | null;
  fulfillment_source_active?: boolean | null;
};
type WorkshopOrderRow = Omit<WorkshopOrder, "workshop" | "items">;

const ORDER_SELECT =
  "id,posting_number,order_id,order_number,status,substatus,ozon_created_at,in_process_at,shipment_date,delivery_method,warehouse_name,customer_name,total_price,source,synced_at,shipped_at,shipped_from_warehouse_id,workshop_order_id,notes,created_at";
const ITEM_SELECT =
  "id,order_id,offer_id,ozon_sku,name,quantity,price,product_id,created_at,shipped_from_warehouse_id";
const WORKSHOP_SELECT =
  "id,order_number,workshop_id,status,notes,created_at,sent_at,completed_at,received_at";

export interface OzonOrderRepository {
  list(options: OzonOrderListOptions): Promise<OzonOrderPage>;
}

export class PostgresOzonOrderRepository implements OzonOrderRepository {
  constructor(
    private readonly query: DatabaseQueryExecutor,
    private readonly products: ProductRepository,
  ) {}

  async list(options: OzonOrderListOptions) {
    const result = (
      await this.query<OzonOrderRow>(
        `
          SELECT
            orders.id,
            orders.posting_number,
            orders.order_id::float8 AS order_id,
            orders.order_number,
            orders.status,
            orders.substatus,
            orders.ozon_created_at,
            orders.in_process_at,
            orders.shipment_date,
            orders.delivery_method,
            orders.warehouse_name,
            orders.customer_name,
            orders.total_price::float8 AS total_price,
            orders.source,
            orders.synced_at,
            orders.shipped_at,
            orders.shipped_from_warehouse_id,
            orders.workshop_order_id,
            orders.fulfillment_order_id,
            orders.notes,
            orders.created_at,
            fulfillment.source_channel AS fulfillment_source_channel,
            fulfillment.fulfillment_scheme AS fulfillment_scheme,
            fulfillment.source_order_key AS fulfillment_source_order_key,
            fulfillment.source_status AS fulfillment_source_status
          FROM merch_ozon_orders orders
          LEFT JOIN merch_fulfillment_orders fulfillment
            ON fulfillment.id = orders.fulfillment_order_id
          WHERE ($2::text IS NULL OR orders.status = $2)
            AND ($3::text IS NULL OR orders.source = $3)
          ORDER BY
            orders.in_process_at DESC NULLS LAST,
            orders.created_at DESC,
            orders.id DESC
          LIMIT $1 OFFSET $4
        `,
        [options.limit + 1, options.status ?? null, options.source ?? null, options.offset],
      )
    ).rows;
    const hasMore = result.length > options.limit;
    const orders = hasMore ? result.slice(0, options.limit) : result;
    const [items, workshopOrders] = await Promise.all([
      this.listItems(orders.map((order) => order.id)),
      this.listWorkshopOrders(
        orders.map((order) => order.workshop_order_id).filter(Boolean) as string[],
      ),
    ]);
    return {
      rows: await hydrateOrders(orders, items, workshopOrders, this.products),
      hasMore,
    };
  }

  private async listItems(orderIds: string[]) {
    if (orderIds.length === 0) return [];
    return (
      await this.query<OzonOrderItemRow>(
        `
          SELECT
            items.id,
            items.order_id,
            items.offer_id,
            items.ozon_sku,
            items.ozon_product_id,
            items.source_item_key,
            items.name,
            items.quantity,
            items.price::float8 AS price,
            items.product_id,
            items.marking_requirement,
            items.exemplar_flow_available,
            items.source_active,
            items.fulfillment_item_id,
            items.created_at,
            items.shipped_from_warehouse_id,
            fulfillment.source_item_key AS fulfillment_source_item_key,
            fulfillment.quantity AS fulfillment_quantity,
            fulfillment.marking_requirement AS fulfillment_marking_requirement,
            fulfillment.exemplar_flow_available
              AS fulfillment_exemplar_flow_available,
            fulfillment.source_active AS fulfillment_source_active
          FROM merch_ozon_order_items items
          LEFT JOIN merch_fulfillment_order_items fulfillment
            ON fulfillment.id = items.fulfillment_item_id
          WHERE items.order_id = ANY($1::uuid[])
            AND items.source_active = true
          ORDER BY items.order_id, items.source_item_key COLLATE "C", items.id
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
      .range(options.offset, options.offset + options.limit);
    if (options.status) query = query.eq("status", options.status);
    if (options.source) query = query.eq("source", options.source);
    const { data, error } = await query;
    if (error) throw repositoryError(error);
    const result = (data ?? []) as OzonOrderRow[];
    const hasMore = result.length > options.limit;
    const orders = hasMore ? result.slice(0, options.limit) : result;
    const [items, workshopOrders] = await Promise.all([
      this.listItems(orders.map((order) => order.id)),
      this.listWorkshopOrders(
        orders.map((order) => order.workshop_order_id).filter(Boolean) as string[],
      ),
    ]);
    return {
      rows: await hydrateOrders(orders, items, workshopOrders, this.products),
      hasMore,
    };
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
  const itemsByOrder = new Map<string, OzonOrderItem[]>();
  for (const item of items) {
    const list = itemsByOrder.get(item.order_id) ?? [];
    const {
      fulfillment_source_item_key: fulfillmentSourceItemKey,
      fulfillment_quantity: fulfillmentQuantity,
      fulfillment_marking_requirement: fulfillmentMarkingRequirement,
      fulfillment_exemplar_flow_available: fulfillmentExemplarFlowAvailable,
      fulfillment_source_active: fulfillmentSourceActive,
      ...itemFields
    } = item;
    list.push({
      ...itemFields,
      product: item.product_id ? productsById.get(item.product_id) ?? null : null,
      fulfillment: item.fulfillment_item_id && fulfillmentSourceItemKey
        ? {
            id: item.fulfillment_item_id,
            source_item_key: fulfillmentSourceItemKey,
            quantity: fulfillmentQuantity ?? item.quantity,
            marking_requirement:
              fulfillmentMarkingRequirement
              ?? item.marking_requirement
              ?? "unknown",
            exemplar_flow_available:
              fulfillmentExemplarFlowAvailable
              ?? item.exemplar_flow_available
              ?? null,
            source_active: fulfillmentSourceActive ?? item.source_active ?? true,
          }
        : null,
    });
    itemsByOrder.set(item.order_id, list);
  }
  return orders.map((order) => {
    const {
      fulfillment_source_channel: fulfillmentSourceChannel,
      fulfillment_scheme: fulfillmentScheme,
      fulfillment_source_order_key: fulfillmentSourceOrderKey,
      fulfillment_source_status: fulfillmentSourceStatus,
      ...orderFields
    } = order;
    return {
      ...orderFields,
      items: itemsByOrder.get(order.id) ?? [],
      workshop_order: order.workshop_order_id
        ? workshopsById.get(order.workshop_order_id) ?? null
        : null,
      fulfillment:
        order.fulfillment_order_id
        && fulfillmentSourceChannel
        && fulfillmentScheme
        && fulfillmentSourceOrderKey
        && fulfillmentSourceStatus
          ? {
              id: order.fulfillment_order_id,
              source_channel: fulfillmentSourceChannel,
              fulfillment_scheme: fulfillmentScheme,
              source_order_key: fulfillmentSourceOrderKey,
              source_status: fulfillmentSourceStatus,
            }
          : null,
    };
  });
}

function byId<T extends { id: string }>(rows: T[]) {
  return new Map(rows.map((row) => [row.id, row]));
}

function repositoryError(error: unknown) {
  return new DatabaseQueryError("Supabase repository query failed", { cause: error });
}
