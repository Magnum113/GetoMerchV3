import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import { applyInventoryDeltas, insertMovement, lockInventoryRows, inventoryKey } from "@/lib/db/mutations/inventory";
import { produceInternal } from "@/lib/db/mutations/inventory-actions";
import { findOrCreateProductInternal } from "@/lib/db/mutations/product-catalog";
import type { MutationOutcome } from "@/lib/db/mutations/runner";
import {
  conflict,
  notFound,
  objectValue,
  oneOf,
  optionalString,
  positiveInteger,
  uuidValue,
} from "@/lib/db/mutations/validation";
import type { WorkshopOrderStatus } from "@/lib/types";

type Checkpoint = (name: string) => void;

export type WorkshopOrderItemInput = {
  blankProductId: string;
  designId: string;
  decorationTypeId: string;
  quantity: number;
  notes: string | null;
  designVersion: string | null;
  hoodieFit: string | null;
  hoodieFabric: string | null;
  /** Заранее известный готовый товар (для позиций из заказа Ozon — конкретный product_id
   *  позиции). При приёмке используется напрямую вместо поиска по атрибутам, чтобы дубли
   *  finished-combo в каталоге не давали ambiguous_product_variant. null — ищем по атрибутам. */
  targetProductId: string | null;
};

export type WorkshopOrderInput = {
  workshopId: string;
  notes: string | null;
  ownWarehouseId: string | null;
  items: WorkshopOrderItemInput[];
};

type WorkshopOrderRow = {
  id: string;
  order_number: string | null;
  workshop_id: string;
  status: WorkshopOrderStatus;
  sent_at: string | null;
  completed_at: string | null;
  received_at: string | null;
};

type WorkshopItemRow = {
  id: string;
  blank_product_id: string | null;
  design_id: string;
  decoration_type_id: string;
  quantity: number;
  design_version: string | null;
  hoodie_fit: string | null;
  hoodie_fabric: string | null;
  target_product_id: string | null;
  category_id: string | null;
  fabric_id: string | null;
  color_id: string | null;
  size_id: string | null;
};

export async function workshopMutation(
  query: DatabaseQueryExecutor,
  action: string,
  args: unknown[],
  checkpoint: Checkpoint,
): Promise<MutationOutcome<unknown>> {
  if (action === "createWorkshopOrder") {
    const result = await createWorkshopOrderInternal(query, parseWorkshopOrder(args[0]), checkpoint);
    return {
      data: result.orderId,
      audit: {
        entityType: "workshop_order",
        entityId: result.orderId,
        after: result,
      },
    };
  }
  if (action === "updateWorkshopOrderStatus") {
    const orderId = uuidValue(args[0], "orderId");
    const status = oneOf(args[1], ["sent", "ready", "received", "cancelled"] as const, "status");
    const options = args[2] == null ? {} : objectValue(args[2], "options");
    return updateWorkshopOrderStatusInternal(
      query,
      orderId,
      status,
      options.ownWarehouseId == null ? null : uuidValue(options.ownWarehouseId, "ownWarehouseId"),
      checkpoint,
    );
  }
  conflict("unsupported_mutation", `Server mutation ${action} не реализована.`);
}

export async function createWorkshopOrderInternal(
  query: DatabaseQueryExecutor,
  input: WorkshopOrderInput,
  checkpoint: Checkpoint,
) {
  const workshop = (
    await query<{ id: string; type: string }>(
      "SELECT id, type FROM merch_warehouses WHERE id = $1::uuid FOR SHARE",
      [input.workshopId],
    )
  ).rows[0];
  if (!workshop) notFound("Склад цеха не найден.");
  if (workshop.type !== "workshop") conflict("invalid_workshop", "Выбранный склад не является цехом.");
  if (input.ownWarehouseId) {
    const own = (
      await query<{ type: string }>(
        "SELECT type FROM merch_warehouses WHERE id = $1::uuid FOR SHARE",
        [input.ownWarehouseId],
      )
    ).rows[0];
    if (!own) notFound("Собственный склад не найден.");
    if (own.type !== "own") conflict("invalid_own_warehouse", "Источник заготовок должен быть собственным складом.");
  }

  const order = (
    await query<{ id: string; order_number: string }>(
      `
        INSERT INTO merch_workshop_orders (
          workshop_id,
          notes,
          status,
          sent_at,
          order_number
        )
        VALUES (
          $1::uuid,
          $2,
          'sent',
          clock_timestamp(),
          'WO-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' ||
            upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
        )
        RETURNING id, order_number
      `,
      [input.workshopId, input.notes],
    )
  ).rows[0];
  checkpoint("after_order");
  await query(
    `
      INSERT INTO merch_workshop_order_items (
        order_id,
        blank_product_id,
        design_id,
        decoration_type_id,
        quantity,
        notes,
        design_version,
        hoodie_fit,
        hoodie_fabric,
        target_product_id
      )
      SELECT
        $1::uuid,
        item.blank_product_id,
        item.design_id,
        item.decoration_type_id,
        item.quantity,
        item.notes,
        item.design_version,
        item.hoodie_fit,
        item.hoodie_fabric,
        item.target_product_id
      FROM jsonb_to_recordset($2::jsonb) AS item(
        blank_product_id uuid,
        design_id uuid,
        decoration_type_id uuid,
        quantity integer,
        notes text,
        design_version text,
        hoodie_fit text,
        hoodie_fabric text,
        target_product_id uuid
      )
    `,
    [order.id, JSON.stringify(input.items.map((item) => ({
      blank_product_id: item.blankProductId,
      design_id: item.designId,
      decoration_type_id: item.decorationTypeId,
      quantity: item.quantity,
      notes: item.notes,
      design_version: item.designVersion,
      hoodie_fit: item.hoodieFit,
      hoodie_fabric: item.hoodieFabric,
      target_product_id: item.targetProductId,
    })))],
  );
  checkpoint("after_items");

  const transfers: Array<{ productId: string; quantity: number; movementId?: string }> = [];
  if (input.ownWarehouseId) {
    const totals = new Map<string, number>();
    for (const item of input.items) {
      totals.set(item.blankProductId, (totals.get(item.blankProductId) ?? 0) + item.quantity);
    }
    const keys = [...totals.keys()].flatMap((productId) => [
      { productId, warehouseId: input.workshopId },
      { productId, warehouseId: input.ownWarehouseId! },
    ]);
    const rows = await lockInventoryRows(query, keys);
    const stock = new Map(rows.map((row) => [inventoryKey(row.product_id, row.warehouse_id), row.quantity]));
    const deltas: Array<{ productId: string; warehouseId: string; delta: number }> = [];
    for (const [productId, quantity] of [...totals].sort(([left], [right]) => left.localeCompare(right))) {
      const workshopHave = stock.get(inventoryKey(productId, input.workshopId)) ?? 0;
      const need = Math.max(0, quantity - workshopHave);
      if (need === 0) continue;
      const ownHave = stock.get(inventoryKey(productId, input.ownWarehouseId)) ?? 0;
      if (ownHave < need) continue;
      deltas.push(
        { productId, warehouseId: input.ownWarehouseId, delta: -need },
        { productId, warehouseId: input.workshopId, delta: need },
      );
      transfers.push({ productId, quantity: need });
    }
    await applyInventoryDeltas(query, deltas);
    checkpoint("after_inventory");
    for (const transfer of transfers) {
      transfer.movementId = await insertMovement(query, {
        type: "transfer",
        productId: transfer.productId,
        fromWarehouseId: input.ownWarehouseId,
        toWarehouseId: input.workshopId,
        quantity: transfer.quantity,
        notes: `Авто-перемещение для заказа ${order.order_number}`,
      });
    }
    checkpoint("after_movements");
  }
  return {
    orderId: order.id,
    orderNumber: order.order_number,
    itemCount: input.items.length,
    transfers,
  };
}

export async function updateWorkshopOrderStatusInternal(
  query: DatabaseQueryExecutor,
  orderId: string,
  status: WorkshopOrderStatus,
  ownWarehouseId: string | null,
  checkpoint: Checkpoint,
): Promise<MutationOutcome<null>> {
  const order = (
    await query<WorkshopOrderRow>(
      `
        SELECT id, order_number, workshop_id, status, sent_at, completed_at, received_at
        FROM merch_workshop_orders
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [orderId],
    )
  ).rows[0];
  if (!order) notFound("Заказ в цех не найден.");
  if (order.status === status) {
    return {
      data: null,
      audit: { entityType: "workshop_order", entityId: orderId, before: order, after: { ...order, unchanged: true } },
    };
  }
  await query(
    `
      UPDATE merch_workshop_orders
      SET status = $2,
          completed_at = CASE WHEN $2 = 'ready' THEN clock_timestamp() ELSE completed_at END,
          received_at = CASE WHEN $2 = 'received' THEN clock_timestamp() ELSE received_at END
      WHERE id = $1::uuid
    `,
    [orderId, status],
  );
  checkpoint("after_status");

  const productions: Array<{ itemId: string; productId: string; quantity: number }> = [];
  if (status === "received" && ownWarehouseId) {
    const items = (
      await query<WorkshopItemRow>(
        `
          SELECT
            item.id,
            item.blank_product_id,
            item.design_id,
            item.decoration_type_id,
            item.quantity,
            item.design_version,
            item.hoodie_fit,
            item.hoodie_fabric,
            item.target_product_id,
            blank.category_id,
            blank.fabric_id,
            blank.color_id,
            blank.size_id
          FROM merch_workshop_order_items item
          LEFT JOIN merch_products blank ON blank.id = item.blank_product_id
          WHERE item.order_id = $1::uuid
          ORDER BY item.id
          FOR UPDATE OF item
        `,
        [orderId],
      )
    ).rows;
    for (const item of items) {
      if (!item.blank_product_id || !item.category_id || !item.fabric_id || !item.color_id || !item.size_id) {
        conflict("invalid_workshop_item", "У позиции заказа отсутствует заготовка.");
      }
      // Для позиций из Ozon целевой готовый товар зафиксирован при создании заказа
      // (target_product_id) — используем его напрямую. Иначе (ручной заказ в цех) ищем/создаём
      // по атрибутам. Поиск по атрибутам после миграции артикулов может вернуть несколько
      // строк, если в каталоге остались дубли finished-combo, поэтому явный товар предпочтителен.
      const finishedId = item.target_product_id
        ?? (
          await findOrCreateProductInternal(query, {
            categoryId: item.category_id,
            fabricId: item.fabric_id,
            colorId: item.color_id,
            sizeId: item.size_id,
            designId: item.design_id,
            decorationTypeId: item.decoration_type_id,
            designVersion: item.design_version,
            hoodieFit: item.hoodie_fit,
            hoodieFabric: item.hoodie_fabric,
          })
        ).product.id;
      await query(
        "UPDATE merch_workshop_order_items SET result_product_id = $2::uuid WHERE id = $1::uuid",
        [item.id, finishedId],
      );
      await produceInternal(query, {
        blankProductId: item.blank_product_id,
        finishedProductId: finishedId,
        warehouseId: order.workshop_id,
        quantity: item.quantity,
        workshopOrderId: orderId,
      }, checkpoint);
      productions.push({ itemId: item.id, productId: finishedId, quantity: item.quantity });
    }
    checkpoint("after_production");
  }
  return {
    data: null,
    audit: {
      entityType: "workshop_order",
      entityId: orderId,
      before: order,
      after: { status, productions },
    },
  };
}

function parseWorkshopOrder(raw: unknown): WorkshopOrderInput {
  const input = objectValue(raw, "workshopOrder");
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 500) {
    conflict("invalid_workshop_items", "Заказ в цех должен содержать от 1 до 500 позиций.");
  }
  return {
    workshopId: uuidValue(input.workshopId, "workshopId"),
    notes: optionalString(input.notes, "notes", 5000),
    ownWarehouseId: input.ownWarehouseId == null ? null : uuidValue(input.ownWarehouseId, "ownWarehouseId"),
    items: input.items.map((rawItem, index) => {
      const item = objectValue(rawItem, `items[${index}]`);
      return {
        blankProductId: uuidValue(item.blankProductId, `items[${index}].blankProductId`),
        designId: uuidValue(item.designId, `items[${index}].designId`),
        decorationTypeId: uuidValue(item.decorationTypeId, `items[${index}].decorationTypeId`),
        quantity: positiveInteger(item.quantity, `items[${index}].quantity`),
        notes: optionalString(item.notes, `items[${index}].notes`, 5000),
        designVersion: optionalString(item.designVersion, `items[${index}].designVersion`, 30),
        hoodieFit: item.hoodieFit == null ? null : oneOf(item.hoodieFit, ["REG", "CRP"] as const, `items[${index}].hoodieFit`),
        hoodieFabric: item.hoodieFabric == null ? null : oneOf(item.hoodieFabric, ["FLC", "NF"] as const, `items[${index}].hoodieFabric`),
        targetProductId: item.targetProductId == null ? null : uuidValue(item.targetProductId, `items[${index}].targetProductId`),
      };
    }),
  };
}
