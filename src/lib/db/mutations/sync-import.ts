import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import type { MarkingRequirement } from "@/lib/fulfillment/ozon-domain";
import { upsertOzonFbsFulfillmentProjection } from "@/lib/fulfillment/ozon-projection";
import { updateColumns } from "@/lib/db/mutations/crud";
import { runServerMutation, type ServerMutationContext } from "@/lib/db/mutations/runner";
import type { ImportAction } from "@/lib/ozon-import";
import {
  selectedOzonImportActions,
  type OzonImportSelection,
} from "@/lib/ozon/import-selection";
import {
  conflict,
  moneyValue,
  notFound,
  objectValue,
  oneOf,
  optionalString,
  positiveInteger,
  stringValue,
  uuidValue,
} from "@/lib/db/mutations/validation";

export type OzonOrderSnapshot = {
  postingNumber: string;
  orderId?: number | null;
  orderNumber?: string | null;
  status: string;
  substatus?: string | null;
  ozonCreatedAt?: string | null;
  inProcessAt?: string | null;
  shipmentDate?: string | null;
  deliveryMethod?: string | null;
  warehouseName?: string | null;
  customerName?: string | null;
  totalPrice?: number | null;
  source: "fbs" | "fbo";
  syncedAt: string;
  replaceItems: boolean;
  items: Array<{
    sourceItemKey: string;
    offerId: string;
    ozonSku?: string | null;
    ozonProductId?: string | null;
    name?: string | null;
    quantity: number;
    price?: number | null;
    productId?: string | null;
    markingRequirement: MarkingRequirement;
    exemplarFlowAvailable: boolean | null;
  }>;
};

type ImportRunRow = {
  id: string;
  status: string;
  summary: Record<string, unknown>;
};

type ImportItemRow = {
  id: string;
  offer_id: string;
  status: string;
  plan: { actions?: unknown[] } | null;
};

type ImportSummary = {
  createdDesigns: number;
  createdProducts: number;
  updatedProducts: number;
  updatedIdentifiers: number;
  updatedPrices: number;
  skipped: number;
  errors: number;
};

export async function syncOzonOrderSnapshot(
  context: ServerMutationContext,
  snapshot: OzonOrderSnapshot,
) {
  return runServerMutation({
    operation: "ozon.order.sync",
    payload: snapshot,
    context,
    execute: async (query, checkpoint) => {
      const input = parseOzonSnapshot(snapshot);
      await query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`ozon-order:${input.postingNumber}`],
      );
      const before = (
        await query<{ id: string; status: string; source: string | null; shipped_at: string | null }>(
          `
            SELECT id, status, source, shipped_at
            FROM merch_ozon_orders
            WHERE posting_number = $1
            FOR UPDATE
          `,
          [input.postingNumber],
        )
      ).rows[0] ?? null;
      if (before?.source && before.source !== input.source) {
        conflict(
          "ozon_order_source_conflict",
          "Источник существующего отправления Ozon не совпадает с новым снимком.",
        );
      }
      const order = (
        await query<{ id: string; created_at: string; shipped_at: string | null }>(
          `
            INSERT INTO merch_ozon_orders (
              posting_number,
              order_id,
              order_number,
              status,
              substatus,
              ozon_created_at,
              in_process_at,
              shipment_date,
              delivery_method,
              warehouse_name,
              customer_name,
              total_price,
              source,
              synced_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::timestamptz,
              $9, $10, $11, $12, $13, $14::timestamptz
            )
            ON CONFLICT (posting_number) DO UPDATE SET
              order_id = EXCLUDED.order_id,
              order_number = EXCLUDED.order_number,
              status = EXCLUDED.status,
              substatus = EXCLUDED.substatus,
              ozon_created_at = EXCLUDED.ozon_created_at,
              in_process_at = EXCLUDED.in_process_at,
              shipment_date = EXCLUDED.shipment_date,
              delivery_method = EXCLUDED.delivery_method,
              warehouse_name = EXCLUDED.warehouse_name,
              customer_name = EXCLUDED.customer_name,
              total_price = EXCLUDED.total_price,
              source = EXCLUDED.source,
              synced_at = EXCLUDED.synced_at
            RETURNING id, created_at, shipped_at
          `,
          [
            input.postingNumber,
            input.orderId,
            input.orderNumber,
            input.status,
            input.substatus,
            input.ozonCreatedAt,
            input.inProcessAt,
            input.shipmentDate,
            input.deliveryMethod,
            input.warehouseName,
            input.customerName,
            input.totalPrice,
            input.source,
            input.syncedAt,
          ],
        )
      ).rows[0];
      checkpoint("after_order");
      let itemsReplaced = false;
      if (input.replaceItems && !order.shipped_at) {
        if (input.items.length > 0) {
          await query(
            `
              INSERT INTO merch_ozon_order_items (
                order_id,
                source_item_key,
                offer_id,
                ozon_sku,
                ozon_product_id,
                name,
                quantity,
                price,
                product_id,
                marking_requirement,
                exemplar_flow_available,
                source_active,
                updated_at
              )
              SELECT
                $1::uuid,
                item.source_item_key,
                item.offer_id,
                item.ozon_sku,
                item.ozon_product_id,
                item.name,
                item.quantity,
                item.price,
                item.product_id,
                item.marking_requirement,
                item.exemplar_flow_available,
                true,
                clock_timestamp()
              FROM jsonb_to_recordset($2::jsonb) AS item(
                source_item_key text,
                offer_id text,
                ozon_sku text,
                ozon_product_id text,
                name text,
                quantity integer,
                price numeric,
                product_id uuid,
                marking_requirement text,
                exemplar_flow_available boolean
              )
              ON CONFLICT (order_id, source_item_key) DO UPDATE SET
                offer_id = EXCLUDED.offer_id,
                ozon_sku = EXCLUDED.ozon_sku,
                ozon_product_id = EXCLUDED.ozon_product_id,
                name = EXCLUDED.name,
                quantity = EXCLUDED.quantity,
                price = EXCLUDED.price,
                product_id = EXCLUDED.product_id,
                marking_requirement = EXCLUDED.marking_requirement,
                exemplar_flow_available = EXCLUDED.exemplar_flow_available,
                source_active = true,
                updated_at = clock_timestamp()
            `,
            [order.id, JSON.stringify(input.items.map((item) => ({
              source_item_key: item.sourceItemKey,
              offer_id: item.offerId,
              ozon_sku: item.ozonSku,
              ozon_product_id: item.ozonProductId,
              name: item.name,
              quantity: item.quantity,
              price: item.price,
              product_id: item.productId,
              marking_requirement: item.markingRequirement,
              exemplar_flow_available: item.exemplarFlowAvailable,
            })))],
          );
        }
        await query(
          `
            UPDATE merch_ozon_order_items
            SET source_active = false, updated_at = clock_timestamp()
            WHERE order_id = $1::uuid
              AND source_active = true
              AND NOT (source_item_key = ANY ($2::text[]))
          `,
          [order.id, input.items.map((item) => item.sourceItemKey)],
        );
        itemsReplaced = true;
      }
      checkpoint("after_items");
      const fulfillment = input.source === "fbs"
        ? await upsertOzonFbsFulfillmentProjection(query, {
            ozonOrderId: order.id,
            postingNumber: input.postingNumber,
            externalOrderId: input.orderId == null ? null : String(input.orderId),
            status: input.status,
            substatus: input.substatus ?? null,
            sourceCreatedAt: input.ozonCreatedAt ?? input.inProcessAt ?? null,
            syncedAt: input.syncedAt,
          })
        : null;
      checkpoint("after_fulfillment");
      const result = {
        id: order.id,
        postingNumber: input.postingNumber,
        created: before === null,
        itemsReplaced,
        itemCount: input.items.length,
        fulfillmentOrderId: fulfillment?.fulfillmentOrderId ?? null,
        fulfillmentItemCount: fulfillment?.itemCount ?? 0,
      };
      return {
        data: result,
        audit: {
          entityType: "ozon_order",
          entityId: order.id,
          before: before ?? {},
          after: { status: input.status, source: input.source, ...result },
        },
      };
    },
  });
}

export async function applyOzonImportRun(
  context: ServerMutationContext,
  runId: string,
  overrides: Record<string, { name?: string; imageUrl?: string | null }>,
  selection: OzonImportSelection,
) {
  return runServerMutation({
    operation: "ozon.import.apply",
    payload: { runId, overrides, selection },
    context,
    execute: async (query, checkpoint) => {
      const id = uuidValue(runId, "runId");
      const run = (
        await query<ImportRunRow>(
          `
            SELECT id, status, summary
            FROM merch_ozon_import_runs
            WHERE id = $1::uuid
            FOR UPDATE
          `,
          [id],
        )
      ).rows[0];
      if (!run) notFound("Запуск импорта Ozon не найден.");
      if (run.status !== "preview" && run.status !== "partial") {
        conflict("import_status_conflict", "Этот импорт уже применен или имеет неподходящий статус.");
      }
      const items = (
        await query<ImportItemRow>(
          `
            SELECT id, offer_id, status, plan
            FROM merch_ozon_import_items
            WHERE run_id = $1::uuid
            ORDER BY offer_id COLLATE "C", id
            FOR UPDATE
          `,
          [id],
        )
      ).rows;
      await query(
        "UPDATE merch_ozon_import_runs SET status = 'applying', error = NULL WHERE id = $1::uuid",
        [id],
      );
      checkpoint("after_run_status");

      const summary: ImportSummary = {
        createdDesigns: 0,
        createdProducts: 0,
        updatedProducts: 0,
        updatedIdentifiers: 0,
        updatedPrices: 0,
        skipped: 0,
        errors: 0,
      };
      const designIds = new Map<string, string>();
      const actionsByItem = new Map<string, ImportAction[]>();
      for (const item of items) {
        const plannedActions = Array.isArray(item.plan?.actions)
          ? item.plan!.actions!.map((action) => objectValue(action, "import action"))
          : [];
        const actions = selectedOzonImportActions(
          plannedActions as unknown as ImportAction[],
          selection,
        );
        actionsByItem.set(item.id, actions);
        for (const action of actions) {
          if (action.type !== "create_design") continue;
          const code = stringValue(action.code, "design code", 100);
          const type = oneOf(action.designType, ["print", "embroidery"] as const, "design type");
          const key = `${code}|${type}`;
          if (designIds.has(key)) continue;
          const design = await findOrCreateImportDesign(query, {
            code,
            type,
            name: stringValue(action.name, "design name", 300),
            imageUrl: optionalString(action.imageUrl, "design image", 2000),
          }, overrides[key]);
          designIds.set(key, design.id);
          if (design.created) summary.createdDesigns += 1;
        }
      }
      checkpoint("after_designs");

      for (const item of items) {
        if (["conflict", "noop", "skipped"].includes(item.status)) {
          summary.skipped += 1;
          continue;
        }
        let changed = false;
        for (const action of actionsByItem.get(item.id) ?? []) {
          if (action.type === "create_design") continue;
          if (action.type === "create_product") {
            const created = await applyCreateProduct(query, objectValue(action.payload, "product payload"), designIds);
            if (created) summary.createdProducts += 1;
            changed ||= created;
          } else if (action.type === "update_product") {
            const hasPrice = "salePrice" in action.patch;
            const hasIdentifiers = ["sku", "ozonSku", "addLegacySku"]
              .some((key) => key in action.patch);
            const updated = await applyUpdateProduct(
              query,
              uuidValue(action.productId, "productId"),
              action.patch,
            );
            if (updated) {
              summary.updatedProducts += 1;
              if (hasPrice) summary.updatedPrices += 1;
              if (hasIdentifiers) summary.updatedIdentifiers += 1;
            }
            changed ||= updated;
          } else {
            conflict("invalid_import_plan", `Неизвестное действие импорта для ${item.offer_id}.`);
          }
        }
        await query(
          `
            UPDATE merch_ozon_import_items
            SET status = $2, applied_at = clock_timestamp(), apply_error = NULL
            WHERE id = $1::uuid
          `,
          [item.id, changed ? "applied" : "skipped"],
        );
        if (!changed) summary.skipped += 1;
      }
      checkpoint("after_items");
      await query(
        `
          UPDATE merch_ozon_import_runs
          SET status = 'applied', summary = $2::jsonb, applied_at = clock_timestamp(), error = NULL
          WHERE id = $1::uuid
        `,
        [id, JSON.stringify(summary)],
      );
      checkpoint("after_run");
      const result = {
        runId: id,
        status: "applied" as const,
        selection,
        summary,
        errors: [] as unknown[],
      };
      return {
        data: result,
        audit: {
          entityType: "ozon_import_run",
          entityId: id,
          before: { status: run.status, summary: run.summary },
          after: result,
        },
      };
    },
  });
}

async function findOrCreateImportDesign(
  query: DatabaseQueryExecutor,
  input: { code: string; type: "print" | "embroidery"; name: string; imageUrl: string | null },
  override: { name?: string; imageUrl?: string | null } | undefined,
) {
  await query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`design:${input.code}:${input.type}`],
  );
  const existing = (
    await query<{ id: string }>(
      "SELECT id FROM merch_designs WHERE code = $1 AND type = $2 ORDER BY id LIMIT 1 FOR UPDATE",
      [input.code, input.type],
    )
  ).rows[0];
  if (existing) return { id: existing.id, created: false };
  const inserted = (
    await query<{ id: string }>(
      `
        INSERT INTO merch_designs (code, type, name, image_url, description)
        VALUES ($1, $2, $3, $4, 'Импортировано из Ozon')
        RETURNING id
      `,
      [
        input.code,
        input.type,
        override?.name?.trim() || input.name,
        override && "imageUrl" in override ? override.imageUrl : input.imageUrl,
      ],
    )
  ).rows[0];
  return { id: inserted.id, created: true };
}

async function applyCreateProduct(
  query: DatabaseQueryExecutor,
  payload: Record<string, unknown>,
  designIds: Map<string, string>,
) {
  const designCode = stringValue(payload.designCode, "designCode", 100);
  const designType = oneOf(payload.designType, ["print", "embroidery"] as const, "designType");
  const designKey = `${designCode}|${designType}`;
  let designId = designIds.get(designKey);
  if (!designId) {
    designId = (
      await query<{ id: string }>(
        "SELECT id FROM merch_designs WHERE code = $1 AND type = $2 ORDER BY id LIMIT 1",
        [designCode, designType],
      )
    ).rows[0]?.id;
  }
  if (!designId) notFound(`Дизайн ${designCode} ${designType} не найден.`);
  const sku = stringValue(payload.sku, "sku", 300);
  const ozonSku = optionalInteger(payload.ozonSku, "ozonSku");
  const inserted = await query<{ id: string }>(
    `
      INSERT INTO merch_products (
        category_id,
        fabric_id,
        color_id,
        size_id,
        design_id,
        decoration_type_id,
        sku,
        ozon_sku,
        sale_price,
        is_blank,
        design_version,
        hoodie_fit,
        hoodie_fabric
      )
      VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
        $7, $8, $9, false, $10, $11, $12
      )
      ON CONFLICT (sku) DO NOTHING
      RETURNING id
    `,
    [
      uuidValue(payload.categoryId, "categoryId"),
      uuidValue(payload.fabricId, "fabricId"),
      uuidValue(payload.colorId, "colorId"),
      uuidValue(payload.sizeId, "sizeId"),
      designId,
      uuidValue(payload.decorationTypeId, "decorationTypeId"),
      sku,
      ozonSku,
      moneyValue(payload.salePrice, "salePrice"),
      optionalString(payload.designVersion, "designVersion", 30),
      payload.hoodieFit == null ? null : oneOf(payload.hoodieFit, ["REG", "CRP"] as const, "hoodieFit"),
      payload.hoodieFabric == null ? null : oneOf(payload.hoodieFabric, ["FLC", "NF"] as const, "hoodieFabric"),
    ],
  );
  return inserted.rowCount === 1;
}

async function applyUpdateProduct(
  query: DatabaseQueryExecutor,
  productId: string,
  patchInput: Record<string, unknown>,
) {
  const product = (
    await query<{ legacy_skus: string[] }>(
      "SELECT legacy_skus FROM merch_products WHERE id = $1::uuid FOR UPDATE",
      [productId],
    )
  ).rows[0];
  if (!product) notFound("Товар импорта не найден.");
  const patch: Record<string, unknown> = {};
  if ("ozonSku" in patchInput) patch.ozon_sku = optionalInteger(patchInput.ozonSku, "ozonSku");
  if ("salePrice" in patchInput) patch.sale_price = moneyValue(patchInput.salePrice, "salePrice");
  if ("sku" in patchInput) patch.sku = stringValue(patchInput.sku, "sku", 300);
  if (patchInput.addLegacySku) {
    patch.legacy_skus = [...new Set([...product.legacy_skus, stringValue(patchInput.addLegacySku, "legacySku", 300)])];
  }
  if (Object.keys(patch).length === 0) return false;
  await updateColumns(query, "merch_products", productId, patch);
  return true;
}

function parseOzonSnapshot(snapshot: OzonOrderSnapshot): OzonOrderSnapshot {
  const input = objectValue(snapshot, "snapshot");
  if (!Array.isArray(input.items) || input.items.length > 500) {
    conflict("invalid_ozon_items", "Снимок заказа содержит некорректное число позиций.");
  }
  return {
    postingNumber: stringValue(input.postingNumber, "postingNumber", 200),
    orderId: optionalInteger(input.orderId, "orderId"),
    orderNumber: optionalString(input.orderNumber, "orderNumber", 200),
    status: stringValue(input.status, "status", 100),
    substatus: optionalString(input.substatus, "substatus", 100),
    ozonCreatedAt: optionalTimestamp(input.ozonCreatedAt, "ozonCreatedAt"),
    inProcessAt: optionalTimestamp(input.inProcessAt, "inProcessAt"),
    shipmentDate: optionalTimestamp(input.shipmentDate, "shipmentDate"),
    deliveryMethod: optionalString(input.deliveryMethod, "deliveryMethod", 300),
    warehouseName: optionalString(input.warehouseName, "warehouseName", 300),
    customerName: optionalString(input.customerName, "customerName", 300),
    totalPrice: moneyValue(input.totalPrice, "totalPrice"),
    source: oneOf(input.source, ["fbs", "fbo"] as const, "source"),
    syncedAt: optionalTimestamp(input.syncedAt, "syncedAt")!,
    replaceItems: input.replaceItems === true,
    items: input.items.map((rawItem, index) => {
      const item = objectValue(rawItem, `items[${index}]`);
      return {
        sourceItemKey: stringValue(item.sourceItemKey, `items[${index}].sourceItemKey`, 1000),
        offerId: stringValue(item.offerId, `items[${index}].offerId`, 300),
        ozonSku: optionalString(item.ozonSku, `items[${index}].ozonSku`, 100),
        ozonProductId: optionalString(
          item.ozonProductId,
          `items[${index}].ozonProductId`,
          200,
        ),
        name: optionalString(item.name, `items[${index}].name`, 1000),
        quantity: positiveInteger(item.quantity, `items[${index}].quantity`),
        price: moneyValue(item.price, `items[${index}].price`),
        productId: item.productId == null ? null : uuidValue(item.productId, `items[${index}].productId`),
        markingRequirement: oneOf(
          item.markingRequirement,
          ["unknown", "required", "not_required"] as const,
          `items[${index}].markingRequirement`,
        ),
        exemplarFlowAvailable: optionalBoolean(
          item.exemplarFlowAvailable,
          `items[${index}].exemplarFlowAvailable`,
        ),
      };
    }),
  };
}

function optionalTimestamp(value: unknown, name: string) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    conflict("invalid_timestamp", `${name}: некорректная дата.`);
  }
  return value;
}

function optionalInteger(value: unknown, name: string) {
  if (value == null || value === "") return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    conflict("invalid_integer", `${name}: некорректное целое число.`);
  }
  return value;
}

function optionalBoolean(value: unknown, name: string) {
  if (value == null) return null;
  if (typeof value !== "boolean") {
    conflict("invalid_boolean", `${name}: ожидалось логическое значение.`);
  }
  return value;
}
