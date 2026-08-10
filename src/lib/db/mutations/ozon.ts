import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import {
  applyInventoryDeltas,
  insertMovement,
  inventoryKey,
  lockInventoryRows,
} from "@/lib/db/mutations/inventory";
import { produceInternal } from "@/lib/db/mutations/inventory-actions";
import type { MutationOutcome } from "@/lib/db/mutations/runner";
import type { ServerMutationContext } from "@/lib/db/mutations/runner";
import {
  createWorkshopOrderInternal,
  updateWorkshopOrderStatusInternal,
  type WorkshopOrderItemInput,
} from "@/lib/db/mutations/workshop";
import {
  conflict,
  notFound,
  objectValue,
  uuidValue,
} from "@/lib/db/mutations/validation";
import { enqueueJob } from "@/lib/jobs/queue";
import { getMarkingRuntimeConfig } from "@/lib/marking/config";
import {
  evaluateShippingGate,
  hasRequiredMarking,
  hasShippingHandover,
  recordShippingHandover,
  type ShippingGateEvaluation,
} from "@/lib/marking/repositories/shipping";

type Checkpoint = (name: string) => void;

type OzonOrderRow = {
  id: string;
  posting_number: string;
  source: string | null;
  status: string;
  shipped_at: string | null;
  shipped_from_warehouse_id: string | null;
  workshop_order_id: string | null;
  fulfillment_order_id: string | null;
};

type OzonItemRow = {
  id: string;
  offer_id: string;
  quantity: number;
  product_id: string | null;
  shipped_from_warehouse_id: string | null;
  category_id: string | null;
  fabric_id: string | null;
  color_id: string | null;
  size_id: string | null;
  design_id: string | null;
  decoration_type_id: string | null;
  design_version: string | null;
  hoodie_fit: string | null;
  hoodie_fabric: string | null;
};

type WarehouseRow = { id: string; type: "own" | "workshop" };

export async function ozonMutation(
  query: DatabaseQueryExecutor,
  action: string,
  args: unknown[],
  checkpoint: Checkpoint,
  context: ServerMutationContext,
): Promise<MutationOutcome<unknown>> {
  switch (action) {
    case "shipOzonOrder": {
      const orderId = uuidValue(args[0], "orderId");
      const preferredWarehouseId = args[1] == null ? null : uuidValue(args[1], "preferredWarehouseId");
      const result = await shipOzonOrderInternal(
        query, orderId, preferredWarehouseId, checkpoint, context,
      );
      return { data: null, audit: ozonAudit(result) };
    }
    case "unshipOzonOrder": {
      const result = await unshipOzonOrderInternal(query, uuidValue(args[0], "orderId"), checkpoint);
      return { data: null, audit: ozonAudit(result) };
    }
    case "createWorkshopOrderFromOzon":
      return createWorkshopOrderFromOzon(query, args[0], checkpoint);
    case "fulfillOzonViaWorkshop":
      return fulfillViaWorkshop(query, args[0], checkpoint, context);
    case "fulfillOzonViaProduction":
      return fulfillViaProduction(query, args[0], checkpoint, context);
    default:
      conflict("unsupported_mutation", `Server mutation ${action} не реализована.`);
  }
}

export async function shipOzonOrderInternal(
  query: DatabaseQueryExecutor,
  orderId: string,
  preferredWarehouseId: string | null,
  checkpoint: Checkpoint,
  context: ServerMutationContext,
) {
  const { order, items } = await loadOrderForUpdate(query, orderId);
  assertFbs(order);
  if (order.shipped_at) conflict("ozon_already_shipped", "Заказ Ozon уже отправлен.");
  if (items.length === 0) conflict("ozon_empty_order", "В заказе Ozon нет позиций.");
  for (const item of items) {
    if (!item.product_id) conflict("ozon_product_unmatched", `Не сопоставлен товар для ${item.offer_id}.`);
  }

  const markingConfig = getMarkingRuntimeConfig();
  let markingGate: ShippingGateEvaluation | null = null;
  if (
    markingConfig.enabled
    && order.fulfillment_order_id
    && await hasRequiredMarking(query, order.fulfillment_order_id)
  ) {
    if (markingConfig.withdrawalEnabled
        && !markingConfig.allowedAdminIds.includes(context.actor)) {
      conflict(
        "marking_shipping_actor_denied",
        "Оператор не входит в разрешённый контур вывода маркировки из оборота.",
      );
    }
    markingGate = await evaluateShippingGate(query, {
      fulfillmentOrderId: order.fulfillment_order_id,
      mode: markingConfig.shippingGateMode,
      actorId: context.actor,
      requestId: context.requestId,
    });
    if (!markingGate.allowed && markingGate.mode === "enforce") {
      conflict(
        "marking_shipping_blocked",
        `Отгрузка заблокирована маркировкой: ${markingGate.blockers.map(shippingBlockerLabel).join("; ")}.`,
      );
    }
  }

  const warehouses = (
    await query<WarehouseRow>(
      `
        SELECT id, type
        FROM merch_warehouses
        ORDER BY
          CASE WHEN id = $1::uuid THEN 0 WHEN type = 'own' THEN 1 ELSE 2 END,
          id
        FOR SHARE
      `,
      [preferredWarehouseId],
    )
  ).rows;
  if (warehouses.length === 0) conflict("warehouse_missing", "Не настроены склады для отгрузки.");
  const productIds = [...new Set(items.map((item) => item.product_id!))].sort();
  const inventoryRows = await lockInventoryRows(
    query,
    productIds.flatMap((productId) => warehouses.map((warehouse) => ({
      productId,
      warehouseId: warehouse.id,
    }))),
  );
  const available = new Map(
    inventoryRows.map((row) => [inventoryKey(row.product_id, row.warehouse_id), row.quantity]),
  );
  const plan: Array<{
    itemId: string;
    offerId: string;
    productId: string;
    warehouseId: string;
    quantity: number;
  }> = [];
  for (const item of items) {
    const productId = item.product_id!;
    const warehouse = warehouses.find((candidate) =>
      (available.get(inventoryKey(productId, candidate.id)) ?? 0) >= item.quantity,
    );
    if (!warehouse) {
      conflict(
        "insufficient_inventory",
        `Недостаточно остатка ни на одном складе: ${item.offer_id} (нужно ${item.quantity}).`,
      );
    }
    const key = inventoryKey(productId, warehouse.id);
    available.set(key, (available.get(key) ?? 0) - item.quantity);
    plan.push({
      itemId: item.id,
      offerId: item.offer_id,
      productId,
      warehouseId: warehouse.id,
      quantity: item.quantity,
    });
  }

  const stockChanges = await applyInventoryDeltas(query, plan.map((step) => ({
    productId: step.productId,
    warehouseId: step.warehouseId,
    delta: -step.quantity,
  })));
  checkpoint("after_inventory");
  const movementIds: string[] = [];
  for (const step of plan) {
    const movementId = await insertMovement(query, {
      type: "sale",
      productId: step.productId,
      fromWarehouseId: step.warehouseId,
      quantity: step.quantity,
      notes: `Ozon ${order.posting_number}`,
    });
    if (movementId) movementIds.push(movementId);
  }
  await query(
    `
      WITH allocation AS (
        SELECT item_id, warehouse_id
        FROM jsonb_to_recordset($1::jsonb) AS x(item_id uuid, warehouse_id uuid)
      )
      UPDATE merch_ozon_order_items item
      SET shipped_from_warehouse_id = allocation.warehouse_id
      FROM allocation
      WHERE item.id = allocation.item_id
    `,
    [JSON.stringify(plan.map((step) => ({ item_id: step.itemId, warehouse_id: step.warehouseId })))],
  );
  const primaryWarehouseId = plan[0]?.warehouseId ?? preferredWarehouseId;
  await query(
    `
      UPDATE merch_ozon_orders
      SET shipped_at = clock_timestamp(), shipped_from_warehouse_id = $2::uuid
      WHERE id = $1::uuid
    `,
    [orderId, primaryWarehouseId],
  );
  checkpoint("after_order");
  let markingHandover: Awaited<ReturnType<typeof recordShippingHandover>> | null = null;
  if (markingGate && order.fulfillment_order_id) {
    markingHandover = await recordShippingHandover(query, {
      fulfillmentOrderId: order.fulfillment_order_id,
      gateEvaluationId: markingGate.id,
      actorId: context.actor,
      requestId: context.requestId,
      idempotencyKey: `shipping-handover:${context.idempotencyKey}`,
    });
    if (markingHandover.documentId && markingConfig.withdrawalEnabled) {
      await enqueueJob({
        type: "marking_withdrawal_submit",
        dedupeKey: `crpt-withdrawal-submit:${markingHandover.documentId}`,
        idempotencyKey: `crpt-withdrawal-submit:${markingHandover.documentId}`,
        payload: { documentId: markingHandover.documentId },
        actor: context.actor,
        requestId: context.requestId,
        maxAttempts: 2,
      }, { query, scope: "marking" });
    }
    checkpoint("after_marking_handover");
  }
  return {
    operation: "ship",
    orderId,
    postingNumber: order.posting_number,
    before: { shippedAt: order.shipped_at, stock: stockChanges.map(({ after: _after, ...change }) => change) },
    after: {
      shipped: true,
      primaryWarehouseId,
      stock: stockChanges,
      plan,
      movementIds,
      markingGate,
      markingHandover,
    },
  };
}

async function unshipOzonOrderInternal(
  query: DatabaseQueryExecutor,
  orderId: string,
  checkpoint: Checkpoint,
) {
  const { order, items } = await loadOrderForUpdate(query, orderId);
  assertFbs(order);
  if (!order.shipped_at) conflict("ozon_not_shipped", "Заказ Ozon не был отправлен.");
  if (order.fulfillment_order_id
      && await hasShippingHandover(query, order.fulfillment_order_id)) {
    conflict(
      "marking_handover_immutable",
      "Отгрузку с зафиксированной передачей маркированного товара нельзя отменить как складскую операцию. Используйте сценарий возврата.",
    );
  }
  const reversal = items
    .filter((item): item is OzonItemRow & { product_id: string } => Boolean(item.product_id))
    .map((item) => ({
      productId: item.product_id,
      warehouseId: item.shipped_from_warehouse_id ?? order.shipped_from_warehouse_id,
      quantity: item.quantity,
    }))
    .filter((item): item is { productId: string; warehouseId: string; quantity: number } => Boolean(item.warehouseId));
  const stockChanges = await applyInventoryDeltas(query, reversal.map((item) => ({
    productId: item.productId,
    warehouseId: item.warehouseId,
    delta: item.quantity,
  })));
  checkpoint("after_inventory");
  const movementIds: string[] = [];
  for (const item of reversal) {
    const movementId = await insertMovement(query, {
      type: "adjustment",
      productId: item.productId,
      toWarehouseId: item.warehouseId,
      quantity: item.quantity,
      notes: `Отмена отправки Ozon ${order.posting_number}`,
    });
    if (movementId) movementIds.push(movementId);
  }
  await query(
    `
      UPDATE merch_ozon_order_items
      SET shipped_from_warehouse_id = NULL
      WHERE order_id = $1::uuid
        AND source_active = true
    `,
    [orderId],
  );
  await query(
    "UPDATE merch_ozon_orders SET shipped_at = NULL, shipped_from_warehouse_id = NULL WHERE id = $1::uuid",
    [orderId],
  );
  checkpoint("after_order");
  return {
    operation: "unship",
    orderId,
    postingNumber: order.posting_number,
    before: { shippedAt: order.shipped_at, shippedFromWarehouseId: order.shipped_from_warehouse_id },
    after: { shipped: false, stock: stockChanges, movementIds },
  };
}

async function createWorkshopOrderFromOzon(
  query: DatabaseQueryExecutor,
  raw: unknown,
  checkpoint: Checkpoint,
): Promise<MutationOutcome<string>> {
  const input = objectValue(raw, "ozonWorkshopOrder");
  const ozonOrderId = uuidValue(input.ozonOrderId, "ozonOrderId");
  const workshopId = uuidValue(input.workshopId, "workshopId");
  const ownWarehouseId = input.ownWarehouseId == null ? null : uuidValue(input.ownWarehouseId, "ownWarehouseId");
  const { order, items } = await loadOrderForUpdate(query, ozonOrderId);
  assertFbs(order);
  if (order.workshop_order_id) conflict("ozon_workshop_exists", "Заказ в цех уже создан.");
  const workshopItems: WorkshopOrderItemInput[] = [];
  for (const item of items) {
    if (!item.product_id || !item.design_id || !item.decoration_type_id) {
      conflict("invalid_ozon_workshop_item", `Позиция ${item.offer_id} не сопоставлена с готовым товаром.`);
    }
    const blankId = await findBlankId(query, item);
    workshopItems.push({
      blankProductId: blankId,
      designId: item.design_id,
      decorationTypeId: item.decoration_type_id,
      quantity: item.quantity,
      notes: `Ozon ${order.posting_number} · ${item.offer_id}`,
      designVersion: item.design_version,
      hoodieFit: item.hoodie_fit,
      hoodieFabric: item.hoodie_fabric,
      // Позиция уже сопоставлена с конкретным готовым товаром Ozon (проверено выше) —
      // фиксируем его, чтобы приёмка из цеха не искала товар по атрибутам и не спотыкалась
      // о дубли finished-combo в каталоге.
      targetProductId: item.product_id,
    });
  }
  if (workshopItems.length === 0) conflict("ozon_empty_order", "Нет позиций для цеха.");
  const workshop = await createWorkshopOrderInternal(query, {
    workshopId,
    ownWarehouseId,
    notes: `Из заказа Ozon ${order.posting_number}`,
    items: workshopItems,
  }, checkpoint);
  await query(
    "UPDATE merch_ozon_orders SET workshop_order_id = $2::uuid WHERE id = $1::uuid",
    [ozonOrderId, workshop.orderId],
  );
  checkpoint("after_link");
  return {
    data: workshop.orderId,
    audit: {
      entityType: "ozon_order",
      entityId: ozonOrderId,
      before: { workshopOrderId: null },
      after: { postingNumber: order.posting_number, workshop },
    },
  };
}

async function fulfillViaWorkshop(
  query: DatabaseQueryExecutor,
  raw: unknown,
  checkpoint: Checkpoint,
  context: ServerMutationContext,
): Promise<MutationOutcome<null>> {
  const input = objectValue(raw, "fulfillOzonViaWorkshop");
  const ozonOrderId = uuidValue(input.ozonOrderId, "ozonOrderId");
  const ownWarehouseId = input.ownWarehouseId == null ? null : uuidValue(input.ownWarehouseId, "ownWarehouseId");
  const { order } = await loadOrderForUpdate(query, ozonOrderId);
  assertFbs(order);
  if (order.shipped_at) conflict("ozon_already_shipped", "Заказ Ozon уже отправлен.");
  if (!order.workshop_order_id) conflict("ozon_workshop_missing", "Заказ в цех не привязан.");
  const workshopResult = await updateWorkshopOrderStatusInternal(
    query,
    order.workshop_order_id,
    "received",
    ownWarehouseId,
    checkpoint,
  );
  const shipping = await shipOzonOrderInternal(
    query, ozonOrderId, ownWarehouseId, checkpoint, context,
  );
  return {
    data: null,
    audit: {
      entityType: "ozon_order",
      entityId: ozonOrderId,
      before: { shipped: false, workshopOrderId: order.workshop_order_id },
      after: { workshop: workshopResult.audit.after, shipping: shipping.after },
    },
  };
}

async function fulfillViaProduction(
  query: DatabaseQueryExecutor,
  raw: unknown,
  checkpoint: Checkpoint,
  context: ServerMutationContext,
): Promise<MutationOutcome<null>> {
  const input = objectValue(raw, "fulfillOzonViaProduction");
  const ozonOrderId = uuidValue(input.ozonOrderId, "ozonOrderId");
  const ownWarehouseId = uuidValue(input.ownWarehouseId, "ownWarehouseId");
  const { order, items } = await loadOrderForUpdate(query, ozonOrderId);
  assertFbs(order);
  if (order.shipped_at) conflict("ozon_already_shipped", "Заказ Ozon уже отправлен.");
  if (order.workshop_order_id) conflict("ozon_workshop_exists", "Заказ Ozon уже привязан к цеху.");
  const warehouses = (
    await query<WarehouseRow>("SELECT id, type FROM merch_warehouses ORDER BY id FOR SHARE")
  ).rows;
  const demand = new Map<string, { quantity: number; item: OzonItemRow }>();
  for (const item of items) {
    if (!item.product_id) conflict("ozon_product_unmatched", `Не сопоставлен товар для ${item.offer_id}.`);
    const current = demand.get(item.product_id);
    demand.set(item.product_id, { quantity: (current?.quantity ?? 0) + item.quantity, item });
  }
  await query(
    `
      SELECT id
      FROM merch_products
      WHERE id = ANY($1::uuid[])
      ORDER BY id
      FOR SHARE
    `,
    [[...demand.keys()].sort()],
  );
  const inventoryRows = await lockInventoryRows(
    query,
    [...demand.keys()].flatMap((productId) => warehouses.map((warehouse) => ({
      productId,
      warehouseId: warehouse.id,
    }))),
  );
  const totals = new Map<string, number>();
  for (const row of inventoryRows) totals.set(row.product_id, (totals.get(row.product_id) ?? 0) + row.quantity);
  const productions: Array<{ productId: string; blankProductId: string; quantity: number }> = [];
  for (const [productId, requested] of [...demand].sort(([left], [right]) => left.localeCompare(right))) {
    const shortage = Math.max(0, requested.quantity - (totals.get(productId) ?? 0));
    if (shortage === 0) continue;
    const blankProductId = await findBlankId(query, requested.item);
    await produceInternal(query, {
      blankProductId,
      finishedProductId: productId,
      warehouseId: ownWarehouseId,
      quantity: shortage,
      notes: `Производство для Ozon ${order.posting_number} · ${requested.item.offer_id}`,
    }, checkpoint);
    productions.push({ productId, blankProductId, quantity: shortage });
  }
  checkpoint("after_production");
  const shipping = await shipOzonOrderInternal(
    query, ozonOrderId, ownWarehouseId, checkpoint, context,
  );
  return {
    data: null,
    audit: {
      entityType: "ozon_order",
      entityId: ozonOrderId,
      before: { shipped: false },
      after: { productions, shipping: shipping.after },
    },
  };
}

async function loadOrderForUpdate(query: DatabaseQueryExecutor, orderId: string) {
  const order = (
    await query<OzonOrderRow>(
      `
        SELECT id, posting_number, source, status, shipped_at,
          shipped_from_warehouse_id, workshop_order_id, fulfillment_order_id
        FROM merch_ozon_orders
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [orderId],
    )
  ).rows[0];
  if (!order) notFound("Заказ Ozon не найден.");
  const items = (
    await query<OzonItemRow>(
      `
        SELECT
          item.id,
          item.offer_id,
          item.quantity,
          item.product_id,
          item.shipped_from_warehouse_id,
          product.category_id,
          product.fabric_id,
          product.color_id,
          product.size_id,
          product.design_id,
          product.decoration_type_id,
          product.design_version,
          product.hoodie_fit,
          product.hoodie_fabric
        FROM merch_ozon_order_items item
        LEFT JOIN merch_products product ON product.id = item.product_id
        WHERE item.order_id = $1::uuid
          AND item.source_active = true
        ORDER BY item.id
        FOR UPDATE OF item
      `,
      [orderId],
    )
  ).rows;
  return { order, items };
}

async function findBlankId(query: DatabaseQueryExecutor, item: OzonItemRow) {
  if (!item.category_id || !item.fabric_id || !item.color_id || !item.size_id) {
    conflict("ozon_product_unmatched", `Не сопоставлен товар для ${item.offer_id}.`);
  }
  const blank = (
    await query<{ id: string }>(
      `
        SELECT id
        FROM merch_products
        WHERE category_id = $1::uuid
          AND fabric_id = $2::uuid
          AND color_id = $3::uuid
          AND size_id = $4::uuid
          AND is_blank = true
        ORDER BY id
        LIMIT 1
        FOR SHARE
      `,
      [item.category_id, item.fabric_id, item.color_id, item.size_id],
    )
  ).rows[0];
  if (!blank) notFound(`Нет пустого SKU для ${item.offer_id}.`);
  return blank.id;
}

function assertFbs(order: OzonOrderRow) {
  if (order.source === "fbo") {
    conflict(
      "ozon_fbo_inventory_forbidden",
      "Заказы Ozon FBO не изменяют внутренние остатки и не создают заказы в цех.",
    );
  }
}

function ozonAudit(result: {
  orderId: string;
  postingNumber: string;
  before: unknown;
  after: unknown;
}) {
  return {
    entityType: "ozon_order",
    entityId: result.orderId,
    before: { postingNumber: result.postingNumber, ...asRecord(result.before) },
    after: result.after,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

function shippingBlockerLabel(value: string) {
  return ({
    unsupported_fulfillment: "неподдерживаемая схема заказа",
    posting_not_shippable: "posting уже не допускает передачу",
    assignment_quantity_mismatch: "не всем единицам назначены КМ",
    marking_unit_not_ready: "КМ не нанесён или не введён в оборот",
    ozon_exemplar_not_accepted: "Ozon не принял КМ",
    withdrawal_location_not_ready: "не заполнены КПП и ФИАС места деятельности",
    product_cost_missing: "не определена цена единицы",
    critical_discrepancy: "есть критическая ручная задача",
  } as Record<string, string>)[value] ?? value;
}
