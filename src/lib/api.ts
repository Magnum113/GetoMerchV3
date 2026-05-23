"use client";

import { createClient } from "@/lib/supabase/client";
import { toError } from "@/lib/utils";
import type {
  Color,
  Design,
  FabricType,
  Inventory,
  Product,
  ProductCategory,
  Size,
  Transaction,
  Warehouse,
  WorkshopOrder,
  WorkshopOrderItem,
  DecorationType,
} from "@/lib/types";

const PRODUCT_SELECT = `
  *,
  category:merch_product_categories(*),
  fabric:merch_fabric_types(*),
  color:merch_colors(*),
  size:merch_sizes(*),
  design:merch_designs(*),
  decoration_type:merch_decoration_types(*)
`;

export const api = {
  // ---------- WAREHOUSES ----------
  async listWarehouses(): Promise<Warehouse[]> {
    const sb = createClient();
    const { data, error } = await sb.from("merch_warehouses").select("*").order("type").order("name");
    if (error) throw toError(error);
    return (data ?? []) as Warehouse[];
  },

  // ---------- CATEGORIES / FABRICS / COLORS / SIZES / DECORATION ----------
  async listCategories(): Promise<ProductCategory[]> {
    const sb = createClient();
    const { data, error } = await sb.from("merch_product_categories").select("*").order("name");
    if (error) throw toError(error);
    return (data ?? []) as ProductCategory[];
  },

  async listFabrics(): Promise<FabricType[]> {
    const sb = createClient();
    const { data, error } = await sb.from("merch_fabric_types").select("*").order("name");
    if (error) throw toError(error);
    return (data ?? []) as FabricType[];
  },

  async listColors(): Promise<Color[]> {
    const sb = createClient();
    const { data, error } = await sb.from("merch_colors").select("*").order("name");
    if (error) throw toError(error);
    return (data ?? []) as Color[];
  },

  async listSizes(): Promise<Size[]> {
    const sb = createClient();
    const { data, error } = await sb.from("merch_sizes").select("*").order("sort_order");
    if (error) throw toError(error);
    return (data ?? []) as Size[];
  },

  async listDecorationTypes(): Promise<DecorationType[]> {
    const sb = createClient();
    const { data, error } = await sb.from("merch_decoration_types").select("*").order("name");
    if (error) throw toError(error);
    return (data ?? []) as DecorationType[];
  },

  async listDesigns(): Promise<Design[]> {
    const sb = createClient();
    const { data, error } = await sb.from("merch_designs").select("*").order("name");
    if (error) throw toError(error);
    return (data ?? []) as Design[];
  },

  // ---------- PRODUCTS ----------
  async listProducts(filters?: { is_blank?: boolean }): Promise<Product[]> {
    const sb = createClient();
    let q = sb.from("merch_products").select(PRODUCT_SELECT).order("created_at", { ascending: false });
    if (filters?.is_blank !== undefined) q = q.eq("is_blank", filters.is_blank);
    const { data, error } = await q;
    if (error) throw toError(error);
    return (data ?? []) as Product[];
  },

  async findOrCreateProduct(input: {
    category_id: string;
    fabric_id: string;
    color_id: string;
    size_id: string;
    design_id?: string | null;
    decoration_type_id?: string | null;
  }): Promise<Product> {
    const sb = createClient();
    const isBlank = !input.design_id && !input.decoration_type_id;
    let query = sb
      .from("merch_products")
      .select(PRODUCT_SELECT)
      .eq("category_id", input.category_id)
      .eq("fabric_id", input.fabric_id)
      .eq("color_id", input.color_id)
      .eq("size_id", input.size_id)
      .eq("is_blank", isBlank);
    if (isBlank) {
      query = query.is("design_id", null).is("decoration_type_id", null);
    } else {
      query = query.eq("design_id", input.design_id!).eq("decoration_type_id", input.decoration_type_id!);
    }

    const { data: existing, error: lookupErr } = await query.maybeSingle();
    if (lookupErr) throw toError(lookupErr);
    if (existing) return existing as Product;

    const sku = await buildSku(input, isBlank);
    const { data, error } = await sb
      .from("merch_products")
      .insert({
        category_id: input.category_id,
        fabric_id: input.fabric_id,
        color_id: input.color_id,
        size_id: input.size_id,
        design_id: input.design_id ?? null,
        decoration_type_id: input.decoration_type_id ?? null,
        is_blank: isBlank,
        sku,
      })
      .select(PRODUCT_SELECT)
      .single();
    if (error) throw toError(error);
    return data as Product;
  },

  async updateProductPrices(id: string, prices: { cost_price?: number | null; sale_price?: number | null }) {
    const sb = createClient();
    const { error } = await sb.from("merch_products").update(prices).eq("id", id);
    if (error) throw toError(error);
  },

  async updateProduct(id: string, patch: { sku?: string | null; cost_price?: number | null; sale_price?: number | null }) {
    const sb = createClient();
    const { error } = await sb.from("merch_products").update(patch).eq("id", id);
    if (error) throw toError(error);
  },

  async deleteProduct(id: string) {
    const sb = createClient();
    const { error } = await sb.from("merch_products").delete().eq("id", id);
    if (error) throw toError(error);
  },

  // ---------- INVENTORY ----------
  async listInventory(warehouseId?: string): Promise<Inventory[]> {
    const sb = createClient();
    let q = sb
      .from("merch_inventory")
      .select(
        `*, product:merch_products(${PRODUCT_SELECT.replace(/\n/g, " ")}), warehouse:merch_warehouses(*)`,
      )
      .gt("quantity", 0)
      .order("updated_at", { ascending: false });
    if (warehouseId) q = q.eq("warehouse_id", warehouseId);
    const { data, error } = await q;
    if (error) throw toError(error);
    return ((data ?? []) as unknown) as Inventory[];
  },

  async getInventoryFor(productId: string, warehouseId: string): Promise<number> {
    const sb = createClient();
    const { data } = await sb
      .from("merch_inventory")
      .select("quantity")
      .eq("product_id", productId)
      .eq("warehouse_id", warehouseId)
      .maybeSingle();
    return data?.quantity ?? 0;
  },

  async adjustInventory(productId: string, warehouseId: string, delta: number) {
    const sb = createClient();
    const { data: existing } = await sb
      .from("merch_inventory")
      .select("id, quantity")
      .eq("product_id", productId)
      .eq("warehouse_id", warehouseId)
      .maybeSingle();

    if (existing) {
      const next = existing.quantity + delta;
      if (next < 0) throw new Error("Недостаточно остатка на складе");
      const { error } = await sb
        .from("merch_inventory")
        .update({ quantity: next })
        .eq("id", existing.id);
      if (error) throw toError(error);
    } else {
      if (delta < 0) throw new Error("Недостаточно остатка на складе");
      const { error } = await sb
        .from("merch_inventory")
        .insert({ product_id: productId, warehouse_id: warehouseId, quantity: delta });
      if (error) throw toError(error);
    }
  },

  // ---------- TRANSACTIONS ----------
  async listTransactions(limit = 100): Promise<Transaction[]> {
    const sb = createClient();
    const { data, error } = await sb
      .from("merch_transactions")
      .select(
        `*, product:merch_products(${PRODUCT_SELECT.replace(/\n/g, " ")}), from_warehouse:merch_warehouses!from_warehouse_id(*), to_warehouse:merch_warehouses!to_warehouse_id(*)`,
      )
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (error) throw toError(error);
    return ((data ?? []) as unknown) as Transaction[];
  },

  // Приёмка извне
  async receive(args: {
    productId: string;
    warehouseId: string;
    quantity: number;
    notes?: string;
  }) {
    const sb = createClient();
    await api.adjustInventory(args.productId, args.warehouseId, args.quantity);
    const { error } = await sb.from("merch_transactions").insert({
      type: "receive",
      product_id: args.productId,
      to_warehouse_id: args.warehouseId,
      quantity: args.quantity,
      notes: args.notes ?? null,
    });
    if (error) throw toError(error);
  },

  // Перемещение между складами
  async transfer(args: {
    productId: string;
    fromWarehouseId: string;
    toWarehouseId: string;
    quantity: number;
    notes?: string;
  }) {
    const sb = createClient();
    await api.adjustInventory(args.productId, args.fromWarehouseId, -args.quantity);
    await api.adjustInventory(args.productId, args.toWarehouseId, args.quantity);
    const { error } = await sb.from("merch_transactions").insert({
      type: "transfer",
      product_id: args.productId,
      from_warehouse_id: args.fromWarehouseId,
      to_warehouse_id: args.toWarehouseId,
      quantity: args.quantity,
      notes: args.notes ?? null,
    });
    if (error) throw toError(error);
  },

  // Продажа (списание со склада)
  async sale(args: {
    productId: string;
    warehouseId: string;
    quantity: number;
    notes?: string;
  }) {
    const sb = createClient();
    await api.adjustInventory(args.productId, args.warehouseId, -args.quantity);
    const { error } = await sb.from("merch_transactions").insert({
      type: "sale",
      product_id: args.productId,
      from_warehouse_id: args.warehouseId,
      quantity: args.quantity,
      notes: args.notes ?? null,
    });
    if (error) throw toError(error);
  },

  // Списание (брак)
  async writeoff(args: {
    productId: string;
    warehouseId: string;
    quantity: number;
    notes?: string;
  }) {
    const sb = createClient();
    await api.adjustInventory(args.productId, args.warehouseId, -args.quantity);
    const { error } = await sb.from("merch_transactions").insert({
      type: "writeoff",
      product_id: args.productId,
      from_warehouse_id: args.warehouseId,
      quantity: args.quantity,
      notes: args.notes ?? null,
    });
    if (error) throw toError(error);
  },

  // Корректировка
  async adjust(args: {
    productId: string;
    warehouseId: string;
    delta: number;
    notes?: string;
  }) {
    const sb = createClient();
    await api.adjustInventory(args.productId, args.warehouseId, args.delta);
    const { error } = await sb.from("merch_transactions").insert({
      type: "adjustment",
      product_id: args.productId,
      to_warehouse_id: args.delta > 0 ? args.warehouseId : null,
      from_warehouse_id: args.delta < 0 ? args.warehouseId : null,
      quantity: Math.abs(args.delta),
      notes: args.notes ?? null,
    });
    if (error) throw toError(error);
  },

  // Производство — превращение пустого в готовый
  async produce(args: {
    blankProductId: string;
    finishedProductId: string;
    warehouseId: string;
    quantity: number;
    workshopOrderId?: string | null;
    notes?: string;
  }) {
    const sb = createClient();
    await api.adjustInventory(args.blankProductId, args.warehouseId, -args.quantity);
    await api.adjustInventory(args.finishedProductId, args.warehouseId, args.quantity);
    const { error } = await sb.from("merch_transactions").insert({
      type: "production",
      product_id: args.finishedProductId,
      source_product_id: args.blankProductId,
      to_warehouse_id: args.warehouseId,
      quantity: args.quantity,
      workshop_order_id: args.workshopOrderId ?? null,
      notes: args.notes ?? null,
    });
    if (error) throw toError(error);
  },

  // ---------- WORKSHOP ORDERS ----------
  async listWorkshopOrders(): Promise<WorkshopOrder[]> {
    const sb = createClient();
    const { data, error } = await sb
      .from("merch_workshop_orders")
      .select(
        `*, workshop:merch_warehouses(*), items:merch_workshop_order_items(*, blank_product:merch_products!blank_product_id(${PRODUCT_SELECT.replace(/\n/g, " ")}), result_product:merch_products!result_product_id(${PRODUCT_SELECT.replace(/\n/g, " ")}), design:merch_designs(*), decoration_type:merch_decoration_types(*))`,
      )
      .order("created_at", { ascending: false });
    if (error) throw toError(error);
    return ((data ?? []) as unknown) as WorkshopOrder[];
  },

  async createWorkshopOrder(args: {
    workshopId: string;
    notes?: string;
    items: {
      blankProductId: string;
      designId: string;
      decorationTypeId: string;
      quantity: number;
      notes?: string;
    }[];
  }): Promise<string> {
    const sb = createClient();
    const orderNumber = `WO-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, "0")}${String(new Date().getDate()).padStart(2, "0")}-${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}`;
    const { data: order, error } = await sb
      .from("merch_workshop_orders")
      .insert({
        workshop_id: args.workshopId,
        notes: args.notes ?? null,
        status: "pending",
        order_number: orderNumber,
      })
      .select()
      .single();
    if (error) throw toError(error);

    const itemsPayload = args.items.map((it) => ({
      order_id: order.id,
      blank_product_id: it.blankProductId,
      design_id: it.designId,
      decoration_type_id: it.decorationTypeId,
      quantity: it.quantity,
      notes: it.notes ?? null,
    }));
    const { error: itemsErr } = await sb.from("merch_workshop_order_items").insert(itemsPayload);
    if (itemsErr) throw toError(itemsErr);
    return order.id as string;
  },

  async updateWorkshopOrderStatus(orderId: string, status: WorkshopOrder["status"], options?: { ownWarehouseId?: string }) {
    const sb = createClient();
    const patch: Record<string, unknown> = { status };
    if (status === "sent") patch.sent_at = new Date().toISOString();
    if (status === "ready") patch.completed_at = new Date().toISOString();
    if (status === "received") patch.received_at = new Date().toISOString();

    const { error } = await sb.from("merch_workshop_orders").update(patch).eq("id", orderId);
    if (error) throw toError(error);

    // Если статус «отправлено» — переместить пустые товары со своего склада в цех
    if (status === "sent" && options?.ownWarehouseId) {
      const order = await api.getWorkshopOrder(orderId);
      if (!order) return;
      for (const it of order.items ?? []) {
        const hasInOwn = await api.getInventoryFor(it.blank_product_id, options.ownWarehouseId);
        const hasInWorkshop = await api.getInventoryFor(it.blank_product_id, order.workshop_id);
        const needFromOwn = Math.max(0, it.quantity - hasInWorkshop);
        if (needFromOwn > 0 && hasInOwn >= needFromOwn) {
          await api.transfer({
            productId: it.blank_product_id,
            fromWarehouseId: options.ownWarehouseId,
            toWarehouseId: order.workshop_id,
            quantity: needFromOwn,
            notes: `Авто-перемещение для заказа ${order.order_number}`,
          });
        }
      }
    }

    // Если статус «получено» — автоматически сделать производство и переместить на свой склад
    if (status === "received" && options?.ownWarehouseId) {
      const order = await api.getWorkshopOrder(orderId);
      if (!order) return;
      for (const it of order.items ?? []) {
        if (!it.blank_product) continue;
        // Find/create finished product SKU
        const finished = await api.findOrCreateProduct({
          category_id: it.blank_product.category_id,
          fabric_id: it.blank_product.fabric_id,
          color_id: it.blank_product.color_id,
          size_id: it.blank_product.size_id,
          design_id: it.design_id,
          decoration_type_id: it.decoration_type_id,
        });

        // Update item with result_product_id
        await sb
          .from("merch_workshop_order_items")
          .update({ result_product_id: finished.id })
          .eq("id", it.id);

        // Производство в цехе
        await api.produce({
          blankProductId: it.blank_product_id,
          finishedProductId: finished.id,
          warehouseId: order.workshop_id,
          quantity: it.quantity,
          workshopOrderId: orderId,
        });

        // Перевозка готового на свой склад
        await api.transfer({
          productId: finished.id,
          fromWarehouseId: order.workshop_id,
          toWarehouseId: options.ownWarehouseId,
          quantity: it.quantity,
          notes: `Возврат с цеха по заказу ${order.order_number}`,
        });
      }
    }
  },

  async getWorkshopOrder(id: string): Promise<WorkshopOrder | null> {
    const sb = createClient();
    const { data, error } = await sb
      .from("merch_workshop_orders")
      .select(
        `*, workshop:merch_warehouses(*), items:merch_workshop_order_items(*, blank_product:merch_products!blank_product_id(${PRODUCT_SELECT.replace(/\n/g, " ")}), result_product:merch_products!result_product_id(${PRODUCT_SELECT.replace(/\n/g, " ")}), design:merch_designs(*), decoration_type:merch_decoration_types(*))`,
      )
      .eq("id", id)
      .single();
    if (error) throw toError(error);
    return (data as unknown) as WorkshopOrder;
  },

  // ---------- DESIGNS CRUD ----------
  async createDesign(input: { name: string; description?: string; image_url?: string }) {
    const sb = createClient();
    const { data, error } = await sb.from("merch_designs").insert(input).select().single();
    if (error) throw toError(error);
    return data as Design;
  },

  async updateDesign(id: string, input: Partial<Design>) {
    const sb = createClient();
    const { error } = await sb.from("merch_designs").update(input).eq("id", id);
    if (error) throw toError(error);
  },

  async deleteDesign(id: string) {
    const sb = createClient();
    const { error } = await sb.from("merch_designs").delete().eq("id", id);
    if (error) throw toError(error);
  },

  // ---------- REFERENCE CRUD ----------
  async createColor(input: { name: string; hex_code?: string }) {
    const sb = createClient();
    const { error } = await sb.from("merch_colors").insert(input);
    if (error) throw toError(error);
  },
  async updateColor(id: string, patch: { name?: string; hex_code?: string | null }) {
    const sb = createClient();
    const { error } = await sb.from("merch_colors").update(patch).eq("id", id);
    if (error) throw toError(error);
  },
  async deleteColor(id: string) {
    const sb = createClient();
    const { error } = await sb.from("merch_colors").delete().eq("id", id);
    if (error) throw toError(error);
  },
  async createSize(input: { name: string; sort_order: number }) {
    const sb = createClient();
    const { error } = await sb.from("merch_sizes").insert(input);
    if (error) throw toError(error);
  },
  async deleteSize(id: string) {
    const sb = createClient();
    const { error } = await sb.from("merch_sizes").delete().eq("id", id);
    if (error) throw toError(error);
  },
  async createWarehouse(input: { name: string; type: "own" | "workshop"; address?: string; contact?: string }) {
    const sb = createClient();
    const { error } = await sb.from("merch_warehouses").insert(input);
    if (error) throw toError(error);
  },
  async updateWarehouse(id: string, patch: { name?: string; type?: "own" | "workshop"; address?: string | null; contact?: string | null; notes?: string | null }) {
    const sb = createClient();
    const { error } = await sb.from("merch_warehouses").update(patch).eq("id", id);
    if (error) throw toError(error);
  },
  async deleteWarehouse(id: string) {
    const sb = createClient();
    const { error } = await sb.from("merch_warehouses").delete().eq("id", id);
    if (error) throw toError(error);
  },
};

async function buildSku(
  input: {
    category_id: string;
    fabric_id: string;
    color_id: string;
    size_id: string;
    design_id?: string | null;
    decoration_type_id?: string | null;
  },
  isBlank: boolean,
): Promise<string> {
  const sb = createClient();
  const [{ data: cat }, { data: fab }, { data: col }, { data: sz }] = await Promise.all([
    sb.from("merch_product_categories").select("slug").eq("id", input.category_id).single(),
    sb.from("merch_fabric_types").select("slug").eq("id", input.fabric_id).single(),
    sb.from("merch_colors").select("name").eq("id", input.color_id).single(),
    sb.from("merch_sizes").select("name").eq("id", input.size_id).single(),
  ]);
  let sku = `${cat?.slug ?? "x"}-${fab?.slug ?? "x"}-${slugify(col?.name ?? "x")}-${sz?.name ?? "x"}`;
  if (!isBlank && input.design_id && input.decoration_type_id) {
    const [{ data: des }, { data: dt }] = await Promise.all([
      sb.from("merch_designs").select("name").eq("id", input.design_id).single(),
      sb.from("merch_decoration_types").select("slug").eq("id", input.decoration_type_id).single(),
    ]);
    sku += `-${slugify(des?.name ?? "x")}-${dt?.slug ?? "x"}`;
  } else {
    sku += "-blank";
  }
  return sku.toUpperCase();
}

function slugify(text: string): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
    и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
    с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
    ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };
  return text
    .toLowerCase()
    .split("")
    .map((c) => map[c] ?? c)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function productName(p?: Product | null): string {
  if (!p) return "—";
  const parts: string[] = [];
  if (p.category) parts.push(p.category.name);
  if (p.fabric) parts.push(p.fabric.name.toLowerCase());
  if (p.color) parts.push(p.color.name);
  if (p.size) parts.push(p.size.name);
  if (p.design && p.decoration_type) {
    parts.push(`· ${p.decoration_type.name}: ${p.design.name}`);
  } else if (p.is_blank) {
    parts.push("· пустая");
  }
  return parts.join(" ");
}
