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
  DesignType,
  OzonOrder,
  OzonFinanceOperation,
  PrintInventory,
  Expense,
  ExpenseCategory,
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

  async listDesigns(filters?: { type?: DesignType }): Promise<Design[]> {
    const sb = createClient();
    let q = sb.from("merch_designs").select("*").order("name");
    if (filters?.type) q = q.eq("type", filters.type);
    const { data, error } = await q;
    if (error) throw toError(error);
    return (data ?? []) as Design[];
  },

  // ---------- PRODUCTS ----------
  async listProducts(filters?: { is_blank?: boolean; design_id?: string }): Promise<Product[]> {
    const sb = createClient();
    let q = sb.from("merch_products").select(PRODUCT_SELECT).order("created_at", { ascending: false });
    if (filters?.is_blank !== undefined) q = q.eq("is_blank", filters.is_blank);
    if (filters?.design_id) q = q.eq("design_id", filters.design_id);
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
    design_version?: string | null;
    hoodie_fit?: string | null;
    hoodie_fabric?: string | null;
  }): Promise<Product> {
    const sb = createClient();
    const isBlank = !input.design_id && !input.decoration_type_id;
    const fit = input.hoodie_fit ?? null;
    const fabric = input.hoodie_fabric ?? null;

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
    // Сужаем по измерениям варианта ТОЛЬКО когда они заданы — для дизайнов с
    // единственным вариантом поведение не меняется. Для дизайна с несколькими
    // вариантами (V01/V02, REG/CRP, FLC/NF) вызывающий обязан их передать.
    if (input.design_version != null) query = query.eq("design_version", input.design_version);
    if (fit != null) query = query.eq("hoodie_fit", fit);
    if (fabric != null) query = query.eq("hoodie_fabric", fabric);

    const { data: matches, error: lookupErr } = await query;
    if (lookupErr) throw toError(lookupErr);
    if ((matches?.length ?? 0) > 1) {
      throw new Error("Несколько вариантов SKU для этой комбинации — уточните версию/посадку/ткань.");
    }
    if (matches && matches.length === 1) return matches[0] as Product;

    // Новый готовый SKU по умолчанию V01 (совпадает с бэкфиллом каталога).
    const version = isBlank ? null : (input.design_version ?? "V01");
    const sku = await buildSku({ ...input, design_version: version, hoodie_fit: fit, hoodie_fabric: fabric }, isBlank);
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
        design_version: version,
        hoodie_fit: fit,
        hoodie_fabric: fabric,
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

  async updateProduct(id: string, patch: { sku?: string | null; cost_price?: number | null; sale_price?: number | null; design_id?: string | null }) {
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
    // Important: merch_transactions has TWO FKs to merch_products (product_id, source_product_id).
    // We MUST disambiguate by using !product_id, otherwise PostgREST returns 300 PGRST201.
    const { data, error } = await sb
      .from("merch_transactions")
      .select(
        `*, product:merch_products!product_id(${PRODUCT_SELECT.replace(/\n/g, " ")}), design:merch_designs!design_id(*), source_design:merch_designs!source_design_id(*), from_warehouse:merch_warehouses!from_warehouse_id(*), to_warehouse:merch_warehouses!to_warehouse_id(*)`,
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

  // Производство — превращение пустого в готовый. Если на готовом стоит decoration_type='print'
  // — автоматически списывается 1 принт нужного дизайна со склада производства.
  async produce(args: {
    blankProductId: string;
    finishedProductId: string;
    warehouseId: string;
    quantity: number;
    workshopOrderId?: string | null;
    notes?: string;
  }) {
    const sb = createClient();
    const { data: finished, error: fErr } = await sb
      .from("merch_products")
      .select("design_id, decoration_type:merch_decoration_types(slug)")
      .eq("id", args.finishedProductId)
      .single();
    if (fErr) throw toError(fErr);

    const dt = (finished?.decoration_type as { slug?: string } | null)?.slug ?? null;
    const consumesPrint = dt === "print" && !!finished?.design_id;

    if (consumesPrint) {
      const have = await api.getPrintInventoryFor(finished!.design_id!, args.warehouseId);
      if (have < args.quantity) throw new Error(`Недостаточно принтов на складе (есть ${have}, нужно ${args.quantity})`);
    }

    await api.adjustInventory(args.blankProductId, args.warehouseId, -args.quantity);
    await api.adjustInventory(args.finishedProductId, args.warehouseId, args.quantity);
    if (consumesPrint) {
      await api.adjustPrintInventory(finished!.design_id!, args.warehouseId, -args.quantity);
    }

    const { error } = await sb.from("merch_transactions").insert({
      type: "production",
      product_id: args.finishedProductId,
      source_product_id: args.blankProductId,
      source_design_id: consumesPrint ? finished!.design_id : null,
      to_warehouse_id: args.warehouseId,
      quantity: args.quantity,
      workshop_order_id: args.workshopOrderId ?? null,
      notes: args.notes ?? null,
    });
    if (error) throw toError(error);
  },

  // ---------- PRINT INVENTORY ----------
  async listPrintInventory(warehouseId?: string): Promise<PrintInventory[]> {
    const sb = createClient();
    let q = sb
      .from("merch_print_inventory")
      .select(`*, design:merch_designs(*), warehouse:merch_warehouses(*)`)
      .gt("quantity", 0)
      .order("updated_at", { ascending: false });
    if (warehouseId) q = q.eq("warehouse_id", warehouseId);
    const { data, error } = await q;
    if (error) throw toError(error);
    return ((data ?? []) as unknown) as PrintInventory[];
  },

  async getPrintInventoryFor(designId: string, warehouseId: string): Promise<number> {
    const sb = createClient();
    const { data } = await sb
      .from("merch_print_inventory")
      .select("quantity")
      .eq("design_id", designId)
      .eq("warehouse_id", warehouseId)
      .maybeSingle();
    return data?.quantity ?? 0;
  },

  async adjustPrintInventory(designId: string, warehouseId: string, delta: number) {
    const sb = createClient();
    const { data: existing } = await sb
      .from("merch_print_inventory")
      .select("id, quantity")
      .eq("design_id", designId)
      .eq("warehouse_id", warehouseId)
      .maybeSingle();
    if (existing) {
      const next = existing.quantity + delta;
      if (next < 0) throw new Error("Недостаточно принтов на складе");
      const { error } = await sb
        .from("merch_print_inventory")
        .update({ quantity: next, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (error) throw toError(error);
    } else {
      if (delta < 0) throw new Error("Недостаточно принтов на складе");
      const { error } = await sb
        .from("merch_print_inventory")
        .insert({ design_id: designId, warehouse_id: warehouseId, quantity: delta });
      if (error) throw toError(error);
    }
  },

  async receivePrint(args: { designId: string; warehouseId: string; quantity: number; notes?: string }) {
    const sb = createClient();
    await api.adjustPrintInventory(args.designId, args.warehouseId, args.quantity);
    const { error } = await sb.from("merch_transactions").insert({
      type: "receive",
      design_id: args.designId,
      to_warehouse_id: args.warehouseId,
      quantity: args.quantity,
      notes: args.notes ?? null,
    });
    if (error) throw toError(error);
  },

  async writeoffPrint(args: { designId: string; warehouseId: string; quantity: number; notes?: string }) {
    const sb = createClient();
    await api.adjustPrintInventory(args.designId, args.warehouseId, -args.quantity);
    const { error } = await sb.from("merch_transactions").insert({
      type: "writeoff",
      design_id: args.designId,
      from_warehouse_id: args.warehouseId,
      quantity: args.quantity,
      notes: args.notes ?? null,
    });
    if (error) throw toError(error);
  },

  async adjustPrint(args: { designId: string; warehouseId: string; delta: number; notes?: string }) {
    const sb = createClient();
    await api.adjustPrintInventory(args.designId, args.warehouseId, args.delta);
    const { error } = await sb.from("merch_transactions").insert({
      type: "adjustment",
      design_id: args.designId,
      to_warehouse_id: args.delta > 0 ? args.warehouseId : null,
      from_warehouse_id: args.delta < 0 ? args.warehouseId : null,
      quantity: Math.abs(args.delta),
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
    ownWarehouseId?: string | null;
    items: {
      blankProductId: string;
      designId: string;
      decorationTypeId: string;
      quantity: number;
      notes?: string;
      designVersion?: string | null;
      hoodieFit?: string | null;
      hoodieFabric?: string | null;
    }[];
  }): Promise<string> {
    const sb = createClient();
    const orderNumber = `WO-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, "0")}${String(new Date().getDate()).padStart(2, "0")}-${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}`;
    const { data: order, error } = await sb
      .from("merch_workshop_orders")
      .insert({
        workshop_id: args.workshopId,
        notes: args.notes ?? null,
        status: "sent",
        sent_at: new Date().toISOString(),
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
      design_version: it.designVersion ?? null,
      hoodie_fit: it.hoodieFit ?? null,
      hoodie_fabric: it.hoodieFabric ?? null,
    }));
    const { error: itemsErr } = await sb.from("merch_workshop_order_items").insert(itemsPayload);
    if (itemsErr) throw toError(itemsErr);

    // Заказ сразу «в работе у цеха» — переносим заготовки со своего склада, если их там не хватает в цехе.
    if (args.ownWarehouseId) {
      for (const it of args.items) {
        const inWorkshop = await api.getInventoryFor(it.blankProductId, args.workshopId);
        const need = Math.max(0, it.quantity - inWorkshop);
        if (need <= 0) continue;
        const inOwn = await api.getInventoryFor(it.blankProductId, args.ownWarehouseId);
        if (inOwn >= need) {
          await api.transfer({
            productId: it.blankProductId,
            fromWarehouseId: args.ownWarehouseId,
            toWarehouseId: args.workshopId,
            quantity: need,
            notes: `Авто-перемещение для заказа ${orderNumber}`,
          });
        }
      }
    }

    return order.id as string;
  },

  async updateWorkshopOrderStatus(orderId: string, status: WorkshopOrder["status"], options?: { ownWarehouseId?: string }) {
    const sb = createClient();
    const patch: Record<string, unknown> = { status };
    if (status === "ready") patch.completed_at = new Date().toISOString();
    if (status === "received") patch.received_at = new Date().toISOString();

    const { error } = await sb.from("merch_workshop_orders").update(patch).eq("id", orderId);
    if (error) throw toError(error);

    // Если статус «получено» — автоматически сделать производство в цехе
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
          design_version: it.design_version ?? null,
          hoodie_fit: it.hoodie_fit ?? null,
          hoodie_fabric: it.hoodie_fabric ?? null,
        });

        // Update item with result_product_id
        await sb
          .from("merch_workshop_order_items")
          .update({ result_product_id: finished.id })
          .eq("id", it.id);

        // Производство в цехе. Готовое остаётся в цехе — оттуда цех сам отправляет в Ozon.
        await api.produce({
          blankProductId: it.blank_product_id,
          finishedProductId: finished.id,
          warehouseId: order.workshop_id,
          quantity: it.quantity,
          workshopOrderId: orderId,
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

  // ---------- OZON ORDERS ----------
  async listOzonOrders(): Promise<OzonOrder[]> {
    const sb = createClient();
    const { data, error } = await sb
      .from("merch_ozon_orders")
      .select(
        `*, workshop_order:merch_workshop_orders(*), items:merch_ozon_order_items(*, product:merch_products(${PRODUCT_SELECT.replace(/\n/g, " ")}))`,
      )
      .order("in_process_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });
    if (error) throw toError(error);
    return ((data ?? []) as unknown) as OzonOrder[];
  },

  async findBlankFor(p: Product): Promise<Product | null> {
    const sb = createClient();
    const { data } = await sb
      .from("merch_products")
      .select(PRODUCT_SELECT)
      .eq("category_id", p.category_id)
      .eq("fabric_id", p.fabric_id)
      .eq("color_id", p.color_id)
      .eq("size_id", p.size_id)
      .eq("is_blank", true)
      .is("design_id", null)
      .is("decoration_type_id", null)
      .maybeSingle();
    return (data as Product | null) ?? null;
  },

  async shipOzonOrder(orderId: string, preferredWarehouseId?: string) {
    const sb = createClient();
    const { data: order, error } = await sb
      .from("merch_ozon_orders")
      .select(`*, items:merch_ozon_order_items(*)`)
      .eq("id", orderId)
      .single();
    if (error) throw toError(error);
    if (!order) throw new Error("Заказ не найден");
    if (order.shipped_at) throw new Error("Заказ уже отправлен");

    const warehouses = await api.listWarehouses();
    const warehouseOrder = [
      ...warehouses.filter((w) => w.id === preferredWarehouseId),
      ...warehouses.filter((w) => w.id !== preferredWarehouseId && w.type === "own"),
      ...warehouses.filter((w) => w.id !== preferredWarehouseId && w.type !== "own"),
    ];

    const plan: { itemId: string; productId: string; warehouseId: string; quantity: number; offer_id: string }[] = [];
    for (const it of (order.items ?? []) as { id: string; product_id: string | null; quantity: number; offer_id: string }[]) {
      if (!it.product_id) throw new Error(`Не сопоставлен товар для offer_id=${it.offer_id}`);
      let picked: string | null = null;
      for (const w of warehouseOrder) {
        const have = await api.getInventoryFor(it.product_id, w.id);
        if (have >= it.quantity) { picked = w.id; break; }
      }
      if (!picked) throw new Error(`Недостаточно остатка ни на одном складе: ${it.offer_id} (нужно ${it.quantity})`);
      plan.push({ itemId: it.id, productId: it.product_id, warehouseId: picked, quantity: it.quantity, offer_id: it.offer_id });
    }

    for (const step of plan) {
      await api.sale({
        productId: step.productId,
        warehouseId: step.warehouseId,
        quantity: step.quantity,
        notes: `Ozon ${order.posting_number}`,
      });
      await sb
        .from("merch_ozon_order_items")
        .update({ shipped_from_warehouse_id: step.warehouseId })
        .eq("id", step.itemId);
    }

    const primary = plan[0]?.warehouseId ?? preferredWarehouseId ?? null;
    const { error: upErr } = await sb
      .from("merch_ozon_orders")
      .update({
        shipped_at: new Date().toISOString(),
        shipped_from_warehouse_id: primary,
      })
      .eq("id", orderId);
    if (upErr) throw toError(upErr);
  },

  async unshipOzonOrder(orderId: string) {
    const sb = createClient();
    const { data: order, error } = await sb
      .from("merch_ozon_orders")
      .select(`*, items:merch_ozon_order_items(*)`)
      .eq("id", orderId)
      .single();
    if (error) throw toError(error);
    if (!order?.shipped_at) throw new Error("Заказ не был отправлен");
    for (const it of (order.items ?? []) as { product_id: string | null; quantity: number; shipped_from_warehouse_id: string | null }[]) {
      if (!it.product_id) continue;
      const wh = it.shipped_from_warehouse_id ?? order.shipped_from_warehouse_id;
      if (!wh) continue;
      await api.adjustInventory(it.product_id, wh, it.quantity);
      await sb.from("merch_transactions").insert({
        type: "adjustment",
        product_id: it.product_id,
        to_warehouse_id: wh,
        quantity: it.quantity,
        notes: `Отмена отправки Ozon ${order.posting_number}`,
      });
    }
    await sb.from("merch_ozon_order_items").update({ shipped_from_warehouse_id: null }).eq("order_id", orderId);
    await sb
      .from("merch_ozon_orders")
      .update({ shipped_at: null, shipped_from_warehouse_id: null })
      .eq("id", orderId);
  },

  // Создать заказ в цех из заказа Ozon (для embroidery-позиций без готового остатка).
  async createWorkshopOrderFromOzon(args: { ozonOrderId: string; workshopId: string; ownWarehouseId?: string | null }): Promise<string> {
    const sb = createClient();
    const { data: ozonRaw, error } = await sb
      .from("merch_ozon_orders")
      .select(`*, items:merch_ozon_order_items(*, product:merch_products(${PRODUCT_SELECT.replace(/\n/g, " ")}))`)
      .eq("id", args.ozonOrderId)
      .single();
    if (error) throw toError(error);
    const ozon = (ozonRaw as unknown) as OzonOrder | null;
    if (!ozon) throw new Error("Заказ Ozon не найден");
    if (ozon.workshop_order_id) throw new Error("Заказ в цех уже создан");

    const items: { blankProductId: string; designId: string; decorationTypeId: string; quantity: number; notes?: string }[] = [];
    for (const it of (ozon.items ?? [])) {
      const p = it.product;
      if (!p) throw new Error(`Не сопоставлен товар: ${it.offer_id}`);
      if (!p.design_id || !p.decoration_type_id) throw new Error(`Позиция ${it.offer_id} без дизайна — не для цеха`);
      const blank = await api.findBlankFor(p);
      if (!blank) throw new Error(`Нет пустого SKU для ${it.offer_id}`);
      items.push({
        blankProductId: blank.id,
        designId: p.design_id,
        decorationTypeId: p.decoration_type_id,
        quantity: it.quantity,
        notes: `Ozon ${ozon.posting_number} · ${it.offer_id}`,
      });
    }
    if (items.length === 0) throw new Error("Нет позиций для цеха");

    const workshopOrderId = await api.createWorkshopOrder({
      workshopId: args.workshopId,
      notes: `Из заказа Ozon ${ozon.posting_number}`,
      ownWarehouseId: args.ownWarehouseId ?? null,
      items,
    });

    const { error: linkErr } = await sb
      .from("merch_ozon_orders")
      .update({ workshop_order_id: workshopOrderId })
      .eq("id", args.ozonOrderId);
    if (linkErr) throw toError(linkErr);

    return workshopOrderId;
  },

  // «Произвели и отправили»: закрывает заказ в цех (production), затем отгружает Ozon.
  async fulfillOzonViaWorkshop(args: { ozonOrderId: string; ownWarehouseId?: string | null }) {
    const sb = createClient();
    const { data: ozon, error } = await sb
      .from("merch_ozon_orders")
      .select("workshop_order_id, shipped_at")
      .eq("id", args.ozonOrderId)
      .single();
    if (error) throw toError(error);
    if (!ozon?.workshop_order_id) throw new Error("Заказ в цех не привязан");
    if (ozon.shipped_at) throw new Error("Заказ уже отправлен");

    const wsId = ozon.workshop_order_id as string;
    const ws = await api.getWorkshopOrder(wsId);
    if (ws && ws.status !== "received") {
      await api.updateWorkshopOrderStatus(wsId, "received", {
        ownWarehouseId: args.ownWarehouseId ?? undefined,
      });
    }
    await api.shipOzonOrder(args.ozonOrderId, args.ownWarehouseId ?? undefined);
  },

  // «Произвёл и отправил»: производит недостающие изделия на своём складе
  // (списывает пустые + принт через api.produce), затем отгружает заказ Ozon.
  // Для печатных позиций, когда готового нет, но есть пустые и принты.
  async fulfillOzonViaProduction(args: { ozonOrderId: string; ownWarehouseId: string }) {
    const sb = createClient();
    if (!args.ownWarehouseId) throw new Error("Не настроен свой склад");
    const { data: ozonRaw, error } = await sb
      .from("merch_ozon_orders")
      .select(`*, items:merch_ozon_order_items(*, product:merch_products(${PRODUCT_SELECT.replace(/\n/g, " ")}))`)
      .eq("id", args.ozonOrderId)
      .single();
    if (error) throw toError(error);
    const ozon = (ozonRaw as unknown) as OzonOrder | null;
    if (!ozon) throw new Error("Заказ Ozon не найден");
    if (ozon.shipped_at) throw new Error("Заказ уже отправлен");
    if (ozon.workshop_order_id) throw new Error("Заказ привязан к цеху");

    for (const it of (ozon.items ?? [])) {
      const p = it.product;
      if (!p) throw new Error(`Не сопоставлен товар: ${it.offer_id}`);
      // Производим только нехватку относительно ВСЕХ складов: если готовое уже
      // есть где-то ещё, его отгрузит shipOzonOrder, лишнего не печатаем.
      const { data: invRows } = await sb
        .from("merch_inventory")
        .select("quantity")
        .eq("product_id", p.id)
        .gt("quantity", 0);
      const totalFinished = (invRows ?? []).reduce((s, r) => s + (r.quantity ?? 0), 0);
      const short = Math.max(0, it.quantity - totalFinished);
      if (short <= 0) continue;
      const blank = await api.findBlankFor(p);
      if (!blank) throw new Error(`Нет пустого SKU для ${it.offer_id}`);
      await api.produce({
        blankProductId: blank.id,
        finishedProductId: p.id,
        warehouseId: args.ownWarehouseId,
        quantity: short,
        notes: `Производство для Ozon ${ozon.posting_number} · ${it.offer_id}`,
      });
    }

    await api.shipOzonOrder(args.ozonOrderId, args.ownWarehouseId);
  },

  async syncOzonOrders(opts: { days?: number; scope?: "active" | "all" } = {}): Promise<{ scope: "active" | "all"; created: number; updated: number; fetched: number; unmatchedItems: number; unmatchedSamples: string[] }> {
    const params = new URLSearchParams();
    if (opts.scope) params.set("scope", opts.scope);
    if (opts.days != null) params.set("days", String(opts.days));
    const res = await fetch(`/api/ozon/sync-orders?${params.toString()}`, { method: "POST" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Sync failed");
    return json;
  },

  // ---------- DESIGNS CRUD ----------
  async createDesign(input: { name: string; type: DesignType; description?: string; image_url?: string }) {
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

  // ---------- EXPENSE CATEGORIES ----------
  async listExpenseCategories(opts?: { includeArchived?: boolean }): Promise<ExpenseCategory[]> {
    const sb = createClient();
    let q = sb.from("merch_expense_categories").select("*").order("sort_order").order("name");
    if (!opts?.includeArchived) q = q.eq("archived", false);
    const { data, error } = await q;
    if (error) throw toError(error);
    return (data ?? []) as ExpenseCategory[];
  },

  async createExpenseCategory(input: { name: string; color?: string | null; sort_order?: number }) {
    const sb = createClient();
    const { data, error } = await sb
      .from("merch_expense_categories")
      .insert({ name: input.name, color: input.color ?? null, sort_order: input.sort_order ?? 0 })
      .select()
      .single();
    if (error) throw toError(error);
    return data as ExpenseCategory;
  },

  async updateExpenseCategory(id: string, patch: { name?: string; color?: string | null; sort_order?: number; archived?: boolean }) {
    const sb = createClient();
    const { error } = await sb.from("merch_expense_categories").update(patch).eq("id", id);
    if (error) throw toError(error);
  },

  async deleteExpenseCategory(id: string) {
    const sb = createClient();
    const { error } = await sb.from("merch_expense_categories").delete().eq("id", id);
    if (error) throw toError(error);
  },

  // ---------- EXPENSES ----------
  async listExpenses(filters?: { from?: string; to?: string; categoryId?: string }): Promise<Expense[]> {
    const sb = createClient();
    let q = sb
      .from("merch_expenses")
      .select(`*, category:merch_expense_categories(*)`)
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: false });
    if (filters?.from) q = q.gte("occurred_at", filters.from);
    if (filters?.to) q = q.lte("occurred_at", filters.to);
    if (filters?.categoryId) q = q.eq("category_id", filters.categoryId);
    const { data, error } = await q;
    if (error) throw toError(error);
    return ((data ?? []) as unknown) as Expense[];
  },

  async createExpense(input: { categoryId: string | null; amount: number; occurredAt: string; description?: string | null }) {
    const sb = createClient();
    const { error } = await sb.from("merch_expenses").insert({
      category_id: input.categoryId,
      amount: input.amount,
      occurred_at: input.occurredAt,
      description: input.description ?? null,
    });
    if (error) throw toError(error);
  },

  async updateExpense(id: string, patch: { categoryId?: string | null; amount?: number; occurredAt?: string; description?: string | null }) {
    const sb = createClient();
    const upd: Record<string, unknown> = {};
    if (patch.categoryId !== undefined) upd.category_id = patch.categoryId;
    if (patch.amount !== undefined) upd.amount = patch.amount;
    if (patch.occurredAt !== undefined) upd.occurred_at = patch.occurredAt;
    if (patch.description !== undefined) upd.description = patch.description;
    const { error } = await sb.from("merch_expenses").update(upd).eq("id", id);
    if (error) throw toError(error);
  },

  async deleteExpense(id: string) {
    const sb = createClient();
    const { error } = await sb.from("merch_expenses").delete().eq("id", id);
    if (error) throw toError(error);
  },

  // ---------- OZON FINANCE OPERATIONS ----------
  async listFinanceOperations(filters?: { from?: string; to?: string }): Promise<OzonFinanceOperation[]> {
    const sb = createClient();
    const pageSize = 1000;
    const out: OzonFinanceOperation[] = [];
    for (let from = 0; ; from += pageSize) {
      let q = sb
        .from("merch_ozon_finance_operations")
        .select("id, operation_id, operation_type, operation_type_name, operation_date, posting_number, accruals_for_sale, sale_commission, amount, services, items, synced_at")
        .order("operation_date", { ascending: false });
      if (filters?.from) q = q.gte("operation_date", filters.from);
      if (filters?.to) q = q.lte("operation_date", filters.to);
      const { data, error } = await q.range(from, from + pageSize - 1);
      if (error) throw toError(error);
      out.push(...(((data ?? []) as unknown) as OzonFinanceOperation[]));
      if (!data || data.length < pageSize) break;
    }
    return out;
  },

  // Все пары (ozon_sku, product) для COGS-фолбэка по items финопов,
  // когда posting_number не сматчился с merch_ozon_orders (FBO, старые заказы и т.п.).
  async listOzonSkuProductMap(): Promise<Array<{ ozon_sku: string; product: Product }>> {
    const sb = createClient();
    const { data, error } = await sb
      .from("merch_ozon_order_items")
      .select(`ozon_sku, product:merch_products(${PRODUCT_SELECT.replace(/\n/g, " ")})`)
      .not("ozon_sku", "is", null)
      .not("product_id", "is", null);
    if (error) throw toError(error);
    const seen = new Set<string>();
    const out: Array<{ ozon_sku: string; product: Product }> = [];
    for (const row of (data ?? []) as unknown as Array<{ ozon_sku: string; product: Product | null }>) {
      const sku = row.ozon_sku;
      if (!sku || seen.has(sku) || !row.product) continue;
      seen.add(sku);
      out.push({ ozon_sku: sku, product: row.product });
    }
    return out;
  },

  async lastFinanceSyncAt(): Promise<string | null> {
    const sb = createClient();
    const { data } = await sb
      .from("merch_ozon_finance_operations")
      .select("synced_at")
      .order("synced_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data?.synced_at as string | null) ?? null;
  },

  async syncOzonFinance(opts: { from?: string; to?: string } = {}): Promise<{ fetched: number; created: number; updated: number; from: string; to: string }> {
    const params = new URLSearchParams();
    if (opts.from) params.set("from", opts.from);
    if (opts.to) params.set("to", opts.to);
    const res = await fetch(`/api/ozon/sync-finance?${params.toString()}`, { method: "POST" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Sync failed");
    return json;
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
    design_version?: string | null;
    hoodie_fit?: string | null;
    hoodie_fabric?: string | null;
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
    // Посадка/ткань худи — чтобы авто-генерируемый артикул оставался
    // уникальным, когда у комбо есть варианты посадки/ткани.
    // (Версия из схемы убрана — разные версии макета = разные дизайн-коды.)
    if (input.hoodie_fit) sku += `-${input.hoodie_fit}`;
    if (input.hoodie_fabric) sku += `-${input.hoodie_fabric}`;
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
