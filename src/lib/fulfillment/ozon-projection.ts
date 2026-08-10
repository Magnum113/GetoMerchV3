import "server-only";

import { createHash } from "node:crypto";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import type { MarkingRequirement } from "@/lib/fulfillment/ozon-domain";

export type OzonFbsFulfillmentProjectionInput = {
  ozonOrderId: string;
  postingNumber: string;
  externalOrderId: string | null;
  status: string;
  substatus: string | null;
  sourceCreatedAt: string | null;
  syncedAt: string;
};

type OzonItemRow = {
  id: string;
  source_item_key: string;
  product_id: string | null;
  offer_id: string;
  ozon_product_id: string | null;
  quantity: number;
  marking_requirement: MarkingRequirement;
  exemplar_flow_available: boolean | null;
  source_active: boolean;
};

export async function upsertOzonFbsFulfillmentProjection(
  query: DatabaseQueryExecutor,
  input: OzonFbsFulfillmentProjectionInput,
) {
  const items = (
    await query<OzonItemRow>(
      `
        SELECT
          id,
          source_item_key,
          product_id,
          offer_id,
          ozon_product_id,
          quantity,
          marking_requirement,
          exemplar_flow_available,
          source_active
        FROM merch_ozon_order_items
        WHERE order_id = $1::uuid
        ORDER BY source_item_key COLLATE "C", id
      `,
      [input.ozonOrderId],
    )
  ).rows;
  const orderRevision = revision({
    postingNumber: input.postingNumber,
    externalOrderId: input.externalOrderId,
    status: input.status,
    substatus: input.substatus,
    items: items.map(itemRevisionInput),
  });
  const fulfillmentOrder = (
    await query<{ id: string }>(
      `
        INSERT INTO merch_fulfillment_orders (
          source_channel,
          fulfillment_scheme,
          source_order_key,
          external_order_id,
          external_posting_number,
          source_status,
          source_substatus,
          source_created_at,
          source_updated_at
        )
        VALUES (
          'ozon_fbs',
          'fbs',
          $1,
          $2,
          $1,
          $3,
          $4,
          $5::timestamptz,
          $6::timestamptz
        )
        ON CONFLICT (source_channel, source_order_key) DO UPDATE SET
          external_order_id = EXCLUDED.external_order_id,
          external_posting_number = EXCLUDED.external_posting_number,
          source_status = EXCLUDED.source_status,
          source_substatus = EXCLUDED.source_substatus,
          source_created_at = COALESCE(
            merch_fulfillment_orders.source_created_at,
            EXCLUDED.source_created_at
          ),
          source_updated_at = EXCLUDED.source_updated_at,
          updated_at = clock_timestamp()
        RETURNING id
      `,
      [
        input.postingNumber,
        input.externalOrderId,
        input.status,
        input.substatus,
        input.sourceCreatedAt,
        input.syncedAt,
      ],
    )
  ).rows[0];

  await query(
    `
      UPDATE merch_ozon_orders
      SET fulfillment_order_id = $2::uuid
      WHERE id = $1::uuid
        AND source = 'fbs'
        AND fulfillment_order_id IS DISTINCT FROM $2::uuid
    `,
    [input.ozonOrderId, fulfillmentOrder.id],
  );

  const currentKeys: string[] = [];
  let activeItemCount = 0;
  let quantityTotal = 0;
  for (const item of items) {
    const fulfillmentItem = (
      await query<{ id: string }>(
        `
          INSERT INTO merch_fulfillment_order_items (
            fulfillment_order_id,
            source_item_key,
            product_id,
            offer_id,
            external_product_id,
            quantity,
            marking_requirement,
            exemplar_flow_available,
            source_active
          )
          VALUES (
            $1::uuid,
            $2,
            $3::uuid,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9
          )
          ON CONFLICT (fulfillment_order_id, source_item_key) DO UPDATE SET
            product_id = EXCLUDED.product_id,
            offer_id = EXCLUDED.offer_id,
            external_product_id = EXCLUDED.external_product_id,
            quantity = EXCLUDED.quantity,
            marking_requirement = EXCLUDED.marking_requirement,
            exemplar_flow_available = EXCLUDED.exemplar_flow_available,
            source_active = EXCLUDED.source_active,
            updated_at = clock_timestamp()
          RETURNING id
        `,
        [
          fulfillmentOrder.id,
          item.source_item_key,
          item.product_id,
          item.offer_id,
          item.ozon_product_id,
          item.quantity,
          item.marking_requirement,
          item.exemplar_flow_available,
          item.source_active,
        ],
      )
    ).rows[0];
    currentKeys.push(item.source_item_key);
    if (item.source_active) {
      activeItemCount += 1;
      quantityTotal += item.quantity;
    }

    await query(
      `
        UPDATE merch_ozon_order_items
        SET fulfillment_item_id = $2::uuid
        WHERE id = $1::uuid
          AND fulfillment_item_id IS DISTINCT FROM $2::uuid
      `,
      [item.id, fulfillmentItem.id],
    );

    const itemRevision = revision(itemRevisionInput(item));
    await appendEvent(query, {
      fulfillmentOrderId: fulfillmentOrder.id,
      fulfillmentItemId: fulfillmentItem.id,
      eventType: "source_item_snapshot",
      sourceRevision: itemRevision,
      occurredAt: input.syncedAt,
      details: {
        sourceItemKey: item.source_item_key,
        quantity: item.quantity,
        markingRequirement: item.marking_requirement,
        exemplarFlowAvailable: item.exemplar_flow_available,
        sourceActive: item.source_active,
      },
    });
  }

  await query(
    `
      UPDATE merch_fulfillment_order_items
      SET source_active = false, updated_at = clock_timestamp()
      WHERE fulfillment_order_id = $1::uuid
        AND source_active = true
        AND NOT (source_item_key = ANY ($2::text[]))
    `,
    [fulfillmentOrder.id, currentKeys],
  );

  await appendEvent(query, {
    fulfillmentOrderId: fulfillmentOrder.id,
    fulfillmentItemId: null,
    eventType: "source_order_snapshot",
    sourceRevision: orderRevision,
    occurredAt: input.syncedAt,
    details: {
      status: input.status,
      substatus: input.substatus,
      activeItemCount,
      quantityTotal,
    },
  });

  return {
    fulfillmentOrderId: fulfillmentOrder.id,
    itemCount: items.length,
    activeItemCount,
    quantityTotal,
    sourceRevision: orderRevision,
  };
}

function itemRevisionInput(item: OzonItemRow) {
  return {
    sourceItemKey: item.source_item_key,
    productId: item.product_id,
    offerId: item.offer_id,
    externalProductId: item.ozon_product_id,
    quantity: item.quantity,
    markingRequirement: item.marking_requirement,
    exemplarFlowAvailable: item.exemplar_flow_available,
    sourceActive: item.source_active,
  };
}

async function appendEvent(
  query: DatabaseQueryExecutor,
  input: {
    fulfillmentOrderId: string;
    fulfillmentItemId: string | null;
    eventType: string;
    sourceRevision: string;
    occurredAt: string;
    details: Record<string, unknown>;
  },
) {
  const dedupeKey = `fulfillment:${revision({
    orderId: input.fulfillmentOrderId,
    itemId: input.fulfillmentItemId,
    eventType: input.eventType,
    sourceRevision: input.sourceRevision,
  })}`;
  await query(
    `
      INSERT INTO merch_fulfillment_events (
        fulfillment_order_id,
        fulfillment_item_id,
        event_type,
        source_revision,
        dedupe_key,
        details,
        occurred_at
      )
      VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::timestamptz)
      ON CONFLICT (dedupe_key) DO NOTHING
    `,
    [
      input.fulfillmentOrderId,
      input.fulfillmentItemId,
      input.eventType,
      input.sourceRevision,
      dedupeKey,
      JSON.stringify(input.details),
      input.occurredAt,
    ],
  );
}

function revision(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(normalize(value)))
    .digest("hex");
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}
