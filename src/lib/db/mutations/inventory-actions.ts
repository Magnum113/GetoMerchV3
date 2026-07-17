import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import {
  applyInventoryDeltas,
  applyPrintInventoryDeltas,
  insertMovement,
} from "@/lib/db/mutations/inventory";
import type { MutationOutcome } from "@/lib/db/mutations/runner";
import {
  conflict,
  notFound,
  objectValue,
  optionalString,
  positiveInteger,
  nonZeroInteger,
  uuidValue,
} from "@/lib/db/mutations/validation";

type Checkpoint = (name: string) => void;

export async function inventoryMutation(
  query: DatabaseQueryExecutor,
  action: string,
  args: unknown[],
  checkpoint: Checkpoint,
): Promise<MutationOutcome<null>> {
  switch (action) {
    case "adjustInventory": {
      const productId = uuidValue(args[0], "productId");
      const warehouseId = uuidValue(args[1], "warehouseId");
      const delta = nonZeroInteger(args[2], "delta");
      const changes = await applyInventoryDeltas(query, [{ productId, warehouseId, delta }]);
      checkpoint("after_inventory");
      return stockOutcome("inventory", `${productId}:${warehouseId}`, changes);
    }
    case "receive":
      return productMovement(query, "receive", args[0], checkpoint);
    case "transfer":
      return transfer(query, args[0], checkpoint);
    case "sale":
      return productMovement(query, "sale", args[0], checkpoint);
    case "writeoff":
      return productMovement(query, "writeoff", args[0], checkpoint);
    case "adjust":
      return adjust(query, args[0], checkpoint);
    case "produce":
      return produce(query, args[0], checkpoint);
    case "adjustPrintInventory": {
      const designId = uuidValue(args[0], "designId");
      const warehouseId = uuidValue(args[1], "warehouseId");
      const delta = nonZeroInteger(args[2], "delta");
      const changes = await applyPrintInventoryDeltas(query, [{ designId, warehouseId, delta }]);
      checkpoint("after_print_inventory");
      return stockOutcome("print_inventory", `${designId}:${warehouseId}`, changes);
    }
    case "receivePrint":
      return printMovement(query, "receive", args[0], checkpoint);
    case "writeoffPrint":
      return printMovement(query, "writeoff", args[0], checkpoint);
    case "adjustPrint":
      return adjustPrint(query, args[0], checkpoint);
    default:
      conflict("unsupported_mutation", `Server mutation ${action} не реализована.`);
  }
}

export async function produceInternal(
  query: DatabaseQueryExecutor,
  input: {
    blankProductId: string;
    finishedProductId: string;
    warehouseId: string;
    quantity: number;
    workshopOrderId?: string | null;
    notes?: string | null;
  },
  checkpoint: Checkpoint,
) {
  if (input.blankProductId === input.finishedProductId) {
    conflict("invalid_production", "Заготовка и готовый товар не могут совпадать.");
  }
  const finished = (
    await query<{ design_id: string | null; decoration_slug: string | null }>(
      `
        SELECT product.design_id, decoration.slug AS decoration_slug
        FROM merch_products product
        LEFT JOIN merch_decoration_types decoration ON decoration.id = product.decoration_type_id
        WHERE product.id = $1::uuid AND product.is_blank = false
        FOR SHARE OF product
      `,
      [input.finishedProductId],
    )
  ).rows[0];
  if (!finished) notFound("Готовый товар для производства не найден.");
  const blank = (
    await query<{ id: string }>(
      "SELECT id FROM merch_products WHERE id = $1::uuid AND is_blank = true FOR SHARE",
      [input.blankProductId],
    )
  ).rows[0];
  if (!blank) notFound("Заготовка для производства не найдена.");

  const productChanges = await applyInventoryDeltas(query, [
    { productId: input.blankProductId, warehouseId: input.warehouseId, delta: -input.quantity },
    { productId: input.finishedProductId, warehouseId: input.warehouseId, delta: input.quantity },
  ]);
  checkpoint("after_product_inventory");
  const consumesPrint = finished.decoration_slug === "print" && Boolean(finished.design_id);
  const printChanges = consumesPrint
    ? await applyPrintInventoryDeltas(query, [{
        designId: finished.design_id!,
        warehouseId: input.warehouseId,
        delta: -input.quantity,
      }])
    : [];
  checkpoint("after_print_inventory");
  const movementId = await insertMovement(query, {
    type: "production",
    productId: input.finishedProductId,
    sourceProductId: input.blankProductId,
    sourceDesignId: consumesPrint ? finished.design_id : null,
    toWarehouseId: input.warehouseId,
    quantity: input.quantity,
    workshopOrderId: input.workshopOrderId ?? null,
    notes: input.notes,
  });
  checkpoint("after_movement");
  return { productChanges, printChanges, movementId };
}

async function productMovement(
  query: DatabaseQueryExecutor,
  type: "receive" | "sale" | "writeoff",
  raw: unknown,
  checkpoint: Checkpoint,
): Promise<MutationOutcome<null>> {
  const input = objectValue(raw, type);
  const productId = uuidValue(input.productId, "productId");
  const warehouseId = uuidValue(input.warehouseId, "warehouseId");
  const quantity = positiveInteger(input.quantity, "quantity");
  const notes = optionalString(input.notes, "notes", 5000);
  const delta = type === "receive" ? quantity : -quantity;
  const changes = await applyInventoryDeltas(query, [{ productId, warehouseId, delta }]);
  checkpoint("after_inventory");
  const movementId = await insertMovement(query, {
    type,
    productId,
    fromWarehouseId: type === "receive" ? null : warehouseId,
    toWarehouseId: type === "receive" ? warehouseId : null,
    quantity,
    notes,
  });
  checkpoint("after_movement");
  return {
    data: null,
    audit: {
      entityType: "inventory_movement",
      entityId: movementId,
      before: { stock: changes.map(({ after: _after, ...change }) => change) },
      after: { stock: changes, movementType: type, movementId },
    },
  };
}

async function transfer(
  query: DatabaseQueryExecutor,
  raw: unknown,
  checkpoint: Checkpoint,
): Promise<MutationOutcome<null>> {
  const input = objectValue(raw, "transfer");
  const productId = uuidValue(input.productId, "productId");
  const fromWarehouseId = uuidValue(input.fromWarehouseId, "fromWarehouseId");
  const toWarehouseId = uuidValue(input.toWarehouseId, "toWarehouseId");
  if (fromWarehouseId === toWarehouseId) conflict("invalid_transfer", "Склады перемещения должны отличаться.");
  const quantity = positiveInteger(input.quantity, "quantity");
  const changes = await applyInventoryDeltas(query, [
    { productId, warehouseId: fromWarehouseId, delta: -quantity },
    { productId, warehouseId: toWarehouseId, delta: quantity },
  ]);
  checkpoint("after_inventory");
  const movementId = await insertMovement(query, {
    type: "transfer",
    productId,
    fromWarehouseId,
    toWarehouseId,
    quantity,
    notes: optionalString(input.notes, "notes", 5000),
  });
  checkpoint("after_movement");
  return movementOutcome(movementId, "transfer", changes);
}

async function adjust(
  query: DatabaseQueryExecutor,
  raw: unknown,
  checkpoint: Checkpoint,
): Promise<MutationOutcome<null>> {
  const input = objectValue(raw, "adjust");
  const productId = uuidValue(input.productId, "productId");
  const warehouseId = uuidValue(input.warehouseId, "warehouseId");
  const delta = nonZeroInteger(input.delta, "delta");
  const changes = await applyInventoryDeltas(query, [{ productId, warehouseId, delta }]);
  checkpoint("after_inventory");
  const movementId = await insertMovement(query, {
    type: "adjustment",
    productId,
    fromWarehouseId: delta < 0 ? warehouseId : null,
    toWarehouseId: delta > 0 ? warehouseId : null,
    quantity: Math.abs(delta),
    notes: optionalString(input.notes, "notes", 5000),
  });
  checkpoint("after_movement");
  return movementOutcome(movementId, "adjustment", changes);
}

async function produce(
  query: DatabaseQueryExecutor,
  raw: unknown,
  checkpoint: Checkpoint,
): Promise<MutationOutcome<null>> {
  const input = objectValue(raw, "produce");
  const values = {
    blankProductId: uuidValue(input.blankProductId, "blankProductId"),
    finishedProductId: uuidValue(input.finishedProductId, "finishedProductId"),
    warehouseId: uuidValue(input.warehouseId, "warehouseId"),
    quantity: positiveInteger(input.quantity, "quantity"),
    workshopOrderId: input.workshopOrderId == null ? null : uuidValue(input.workshopOrderId, "workshopOrderId"),
    notes: optionalString(input.notes, "notes", 5000),
  };
  const result = await produceInternal(query, values, checkpoint);
  return {
    data: null,
    audit: {
      entityType: "production",
      entityId: result.movementId,
      before: {
        products: result.productChanges.map(({ after: _after, ...change }) => change),
        prints: result.printChanges.map(({ after: _after, ...change }) => change),
      },
      after: { ...result, quantity: values.quantity },
    },
  };
}

async function printMovement(
  query: DatabaseQueryExecutor,
  type: "receive" | "writeoff",
  raw: unknown,
  checkpoint: Checkpoint,
): Promise<MutationOutcome<null>> {
  const input = objectValue(raw, `${type}Print`);
  const designId = uuidValue(input.designId, "designId");
  const warehouseId = uuidValue(input.warehouseId, "warehouseId");
  const quantity = positiveInteger(input.quantity, "quantity");
  const changes = await applyPrintInventoryDeltas(query, [{
    designId,
    warehouseId,
    delta: type === "receive" ? quantity : -quantity,
  }]);
  checkpoint("after_print_inventory");
  const movementId = await insertMovement(query, {
    type,
    designId,
    fromWarehouseId: type === "writeoff" ? warehouseId : null,
    toWarehouseId: type === "receive" ? warehouseId : null,
    quantity,
    notes: optionalString(input.notes, "notes", 5000),
  });
  checkpoint("after_movement");
  return {
    data: null,
    audit: {
      entityType: "print_inventory_movement",
      entityId: movementId,
      before: changes.map(({ after: _after, ...change }) => change),
      after: { stock: changes, movementType: type, movementId },
    },
  };
}

async function adjustPrint(
  query: DatabaseQueryExecutor,
  raw: unknown,
  checkpoint: Checkpoint,
): Promise<MutationOutcome<null>> {
  const input = objectValue(raw, "adjustPrint");
  const designId = uuidValue(input.designId, "designId");
  const warehouseId = uuidValue(input.warehouseId, "warehouseId");
  const delta = nonZeroInteger(input.delta, "delta");
  const changes = await applyPrintInventoryDeltas(query, [{ designId, warehouseId, delta }]);
  checkpoint("after_print_inventory");
  const movementId = await insertMovement(query, {
    type: "adjustment",
    designId,
    fromWarehouseId: delta < 0 ? warehouseId : null,
    toWarehouseId: delta > 0 ? warehouseId : null,
    quantity: Math.abs(delta),
    notes: optionalString(input.notes, "notes", 5000),
  });
  checkpoint("after_movement");
  return {
    data: null,
    audit: {
      entityType: "print_inventory_movement",
      entityId: movementId,
      before: changes.map(({ after: _after, ...change }) => change),
      after: { stock: changes, movementType: "adjustment", movementId },
    },
  };
}

function movementOutcome(
  movementId: string | undefined,
  movementType: string,
  changes: Array<Record<string, unknown> & { before: number; after: number }>,
): MutationOutcome<null> {
  return {
    data: null,
    audit: {
      entityType: "inventory_movement",
      entityId: movementId,
      before: { stock: changes.map(({ after: _after, ...change }) => change) },
      after: { stock: changes, movementType, movementId },
    },
  };
}

function stockOutcome(
  entityType: string,
  entityId: string,
  changes: Array<Record<string, unknown> & { before: number; after: number }>,
): MutationOutcome<null> {
  return {
    data: null,
    audit: {
      entityType,
      entityId,
      before: changes.map(({ after: _after, ...change }) => change),
      after: changes,
    },
  };
}
