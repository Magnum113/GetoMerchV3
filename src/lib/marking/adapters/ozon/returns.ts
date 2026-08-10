import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/marking/domain/crpt-introduction";

export const OZON_FBS_RETURNS_CONTRACT_VERSION =
  "ozon-seller-v3-returns-company-fbs-2026-08-10";

export type NormalizedOzonReturn = {
  sourceReturnId: string;
  sourceReturnItemId: string;
  postingNumber: string;
  offerId: string | null;
  ozonSku: string | null;
  quantity: number;
  returnKind:
    | "cancel_before_handover"
    | "return_to_seller"
    | "not_picked_up_to_seller"
    | "unknown";
  sourceStatus: string;
  observedAt: string | null;
  snapshotHash: string;
  evidence: Record<string, unknown>;
};

export type OzonFbsReturnsPage = {
  items: NormalizedOzonReturn[];
  lastId: string | null;
  hasNext: boolean;
};

export class OzonReturnsContractError extends Error {
  readonly code = "ozon_returns_contract_invalid";

  constructor(message: string) {
    super(message);
    this.name = "OzonReturnsContractError";
  }
}

export function parseOzonFbsReturnsPage(value: unknown): OzonFbsReturnsPage {
  const root = object(value, "Ozon returns response");
  const payload = isRecord(root.result) ? root.result : root;
  const rawItems = Array.isArray(payload.returns)
    ? payload.returns
    : Array.isArray(payload.items)
      ? payload.items
      : null;
  if (!rawItems) {
    throw new OzonReturnsContractError("Ozon returns response has no returns array");
  }
  const items = rawItems.map((item, index) => normalizeReturn(item, index));
  const lastId = optionalScalar(payload.last_id ?? payload.lastId);
  const hasNext = boolean(payload.has_next ?? payload.hasNext)
    ?? (lastId !== null && items.length > 0);
  return { items, lastId, hasNext };
}

function normalizeReturn(value: unknown, index: number): NormalizedOzonReturn {
  const row = object(value, `Ozon return ${index}`);
  const product = isRecord(row.product) ? row.product : {};
  const sourceReturnId = requiredScalar(row.id ?? row.return_id, "return id");
  const postingNumber = requiredScalar(
    row.posting_number ?? row.postingNumber,
    "posting number",
  );
  const offerId = optionalScalar(
    row.product_offer_id ?? row.offer_id ?? product.offer_id,
  );
  const ozonSku = optionalScalar(row.sku ?? product.sku);
  const quantity = positiveInteger(row.quantity ?? 1, "return quantity");
  const sourceStatus = requiredScalar(row.status ?? "unknown", "return status");
  const reason = optionalScalar(
    row.return_reason_name ?? row.returnReasonName ?? row.reason,
  );
  const returnedAt = optionalIso(
    row.returned_to_seller_moment
      ?? row.returnedToSellerMoment
      ?? row.returned_to_seller_at,
  );
  const observedAt = optionalIso(
    row.accepted_from_customer_moment
      ?? row.acceptedFromCustomerMoment
      ?? returnedAt
      ?? row.updated_at,
  );
  const returnKind = normalizeKind({ sourceStatus, reason, returnedAt });
  const evidence = {
    id: sourceReturnId,
    postingNumber,
    offerId,
    ozonSku,
    quantity,
    status: sourceStatus,
    reason,
    movingToPlaceName: optionalScalar(
      row.moving_to_place_name ?? row.movingToPlaceName,
    ),
    acceptedFromCustomerAt: optionalIso(
      row.accepted_from_customer_moment ?? row.acceptedFromCustomerMoment,
    ),
    returnedToSellerAt: returnedAt,
    observedAt,
  };
  return {
    sourceReturnId,
    sourceReturnItemId: sourceReturnId,
    postingNumber,
    offerId,
    ozonSku,
    quantity,
    returnKind,
    sourceStatus,
    observedAt,
    snapshotHash: createHash("sha256")
      .update(canonicalJson(evidence))
      .digest("hex"),
    evidence,
  };
}

function normalizeKind(input: {
  sourceStatus: string;
  reason: string | null;
  returnedAt: string | null;
}): NormalizedOzonReturn["returnKind"] {
  const status = input.sourceStatus.toLowerCase();
  const reason = input.reason?.toLowerCase() ?? "";
  if (status === "cancelled" || status === "canceled") {
    return "cancel_before_handover";
  }
  if (input.returnedAt && /не\s*выкуп|не\s*забрал|not.?picked|unclaimed/i.test(reason)) {
    return "not_picked_up_to_seller";
  }
  if (input.returnedAt) return "return_to_seller";
  return "unknown";
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new OzonReturnsContractError(`${name} is not an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredScalar(value: unknown, name: string) {
  const parsed = optionalScalar(value);
  if (!parsed) throw new OzonReturnsContractError(`Missing ${name}`);
  return parsed;
}

function optionalScalar(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 500);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function positiveInteger(value: unknown, name: string) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new OzonReturnsContractError(`Invalid ${name}`);
  }
  return parsed;
}

function boolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function optionalIso(value: unknown): string | null {
  const raw = optionalScalar(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
