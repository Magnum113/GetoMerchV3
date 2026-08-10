import { createHash } from "node:crypto";
import { normalizeGtin14 } from "@/lib/marking/domain/invariants";

export const SUZ_CONTRACT_VERSION = "suz-api-3.0-2026-07-24";

export class SuzContractError extends Error {
  readonly code = "suz_contract_invalid";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SuzContractError";
  }
}

export function buildSuzLpOrder(input: { gtin: string; quantity: number }) {
  const gtin = normalizeGtin14(input.gtin);
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 5000) {
    throw new SuzContractError("SUZ order quantity must be between 1 and 5000");
  }
  const payload = {
    productGroup: "lp",
    products: [{
      gtin,
      quantity: input.quantity,
      serialNumberType: "OPERATOR",
      templateId: 10,
      cisType: "UNIT",
    }],
    attributes: {
      releaseMethodType: "PRODUCTION",
      createMethodType: "SELF_MADE",
    },
  } as const;
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  return { payload, bytes, requestHash: createHash("sha256").update(bytes).digest("hex") };
}

export function parseSuzOrderCreated(value: unknown) {
  const row = record(value, "SUZ create-order response");
  return {
    omsId: uuid(row.omsId, "omsId"),
    orderId: uuid(row.orderId, "orderId"),
    expectedCompletionTimeMs: integer(row.expectedCompletionTime, "expectedCompletionTime", 0, 3_600_000),
  };
}

export function parseSuzOrderStatus(value: unknown, expectedGtin: string) {
  const row = record(value, "SUZ order-status response");
  const buffers = array(row.buffers, "buffers");
  const gtin = normalizeGtin14(expectedGtin);
  const matches = buffers.filter((item) => record(item, "SUZ buffer").gtin === gtin);
  if (matches.length !== 1) {
    throw new SuzContractError("SUZ order status does not contain exactly one expected GTIN");
  }
  const buffer = record(matches[0], "SUZ buffer");
  return {
    orderId: uuid(row.orderId, "orderId"),
    productGroup: text(row.productGroup, "productGroup", 1, 40),
    orderStatus: text(row.orderStatus, "orderStatus", 1, 120),
    gtin,
    bufferStatus: text(buffer.bufferStatus, "bufferStatus", 1, 120),
    availableCodes: integer(buffer.availableCodes, "availableCodes", 0, 2_000_000),
    templateId: integer(buffer.templateId, "templateId", 1, 1000),
  };
}

export function parseSuzCodes(value: unknown, expectedQuantity: number) {
  const row = record(value, "SUZ codes response");
  const rawCodes = array(row.codes, "codes");
  if (rawCodes.length < 1 || rawCodes.length > expectedQuantity || rawCodes.length > 5000) {
    throw new SuzContractError("SUZ returned an invalid code quantity");
  }
  const codes = rawCodes.map((item) => {
    if (typeof item !== "string" || item.length < 1 || Buffer.byteLength(item, "utf8") > 512) {
      throw new SuzContractError("SUZ returned invalid marking-code material");
    }
    return item;
  });
  return {
    omsId: uuid(row.omsId, "omsId"),
    blockId: uuid(row.blockId, "blockId"),
    codes,
  };
}

export function parseSuzCodeBlocks(
  value: unknown,
  expectedOrderId: string,
  expectedGtin: string,
) {
  const row = record(value, "SUZ code-block response");
  const orderId = uuid(row.orderId, "orderId");
  const gtin = normalizeGtin14(text(row.gtin, "gtin", 14, 14));
  if (orderId !== expectedOrderId || gtin !== normalizeGtin14(expectedGtin)) {
    throw new SuzContractError("SUZ code-block response does not match the order");
  }
  const blocks = array(row.blocks, "blocks").map((item) => {
    const block = record(item, "SUZ code block");
    return {
      blockId: uuid(block.blockId, "blockId"),
      quantity: integer(block.quantity, "quantity", 1, 5000),
    };
  });
  if (blocks.length > 5000 || new Set(blocks.map((block) => block.blockId)).size !== blocks.length) {
    throw new SuzContractError("SUZ returned an invalid code-block list");
  }
  return { orderId, gtin, blocks };
}

export function parseSuzUtilisationReceipt(value: unknown, expectedGtin: string) {
  const row = record(value, "SUZ receipt-search response");
  integer(row.totalCount, "totalCount", 0, Number.MAX_SAFE_INTEGER);
  const candidates = array(row.results, "results")
    .map((item) => record(item, "SUZ receipt"))
    .filter((item) => item.workflow === "REPORT_UTILIZE");
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new SuzContractError("SUZ returned multiple REPORT_UTILIZE receipts for one order");
  }
  const receipt = candidates[0];
  const operations = array(receipt.operations, "operations").map((item) =>
    record(item, "SUZ receipt operation"));
  const processedOperations = operations.filter((item) => item.operationType === "RNMS_GIS_PROCESSED");
  if (processedOperations.length !== 1) {
    throw new SuzContractError("SUZ receipt does not contain one RNMS_GIS_PROCESSED operation");
  }
  const details = record(processedOperations[0].details, "SUZ receipt operation details");
  const gtin = normalizeGtin14(text(details.gtin, "receipt gtin", 14, 14));
  if (gtin !== normalizeGtin14(expectedGtin)) {
    throw new SuzContractError("SUZ receipt GTIN does not match the order");
  }
  return {
    receiptId: uuid(receipt.resultDocId, "resultDocId"),
    state: text(receipt.state, "receipt state", 1, 120),
    code: integer(receipt.code, "receipt code", -100000, 100000),
    workflow: "REPORT_UTILIZE" as const,
    gtin,
    processed: integer(details.processed, "processed", 0, 2_000_000),
    total: integer(details.total, "total", 0, 2_000_000),
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SuzContractError(`${name} is not an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new SuzContractError(`SUZ ${name} is not an array`);
  return value;
}

function text(value: unknown, name: string, minimum: number, maximum: number) {
  if (typeof value !== "string") throw new SuzContractError(`SUZ ${name} is invalid`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum || /[\u0000\r\n]/.test(normalized)) {
    throw new SuzContractError(`SUZ ${name} is invalid`);
  }
  return normalized;
}

function uuid(value: unknown, name: string) {
  const normalized = text(value, name, 36, 36).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new SuzContractError(`SUZ ${name} is not a UUID`);
  }
  return normalized;
}

function integer(value: unknown, name: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new SuzContractError(`SUZ ${name} is invalid`);
  }
  return Number(value);
}
