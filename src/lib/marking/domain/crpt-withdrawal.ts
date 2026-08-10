import { parseGs1MarkingCode } from "@/lib/marking/domain/code-pool";
import {
  canonicalJson,
  extractIdentificationCode,
} from "@/lib/marking/domain/crpt-introduction";

export const CRPT_WITHDRAWAL_CONTRACT_VERSION =
  "true-api-lk-receipt-v649.0-2026-04-15";

export class CrptWithdrawalPayloadError extends Error {
  readonly code = "crpt_withdrawal_payload_invalid";

  constructor(message: string) {
    super(message);
    this.name = "CrptWithdrawalPayloadError";
  }
}

export function buildLkReceiptDistancePayload(input: {
  inn: string;
  actionDate: string;
  postingNumber: string;
  kpp: string;
  fiasId: string;
  products: Array<{
    gtin: string;
    productCostMinor: number;
    markingCode: Uint8Array;
  }>;
}) {
  if (!/^\d{10}(?:\d{2})?$/.test(input.inn)) {
    throw new CrptWithdrawalPayloadError("INN is required for CRPT withdrawal");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.actionDate)) {
    throw new CrptWithdrawalPayloadError("Withdrawal action date is invalid");
  }
  if (!/^\d{9}$/.test(input.kpp) || input.fiasId.length < 1 || input.fiasId.length > 120) {
    throw new CrptWithdrawalPayloadError("KPP and FIAS ID are required for distance sale");
  }
  if (input.postingNumber.length < 1 || input.postingNumber.length > 300) {
    throw new CrptWithdrawalPayloadError("Posting number is invalid");
  }
  if (input.products.length < 1 || input.products.length > 10_000) {
    throw new CrptWithdrawalPayloadError("Withdrawal products are missing or too numerous");
  }

  const products = input.products.map((product) => {
    if (!/^\d{14}$/.test(product.gtin)) {
      throw new CrptWithdrawalPayloadError("Withdrawal GTIN is invalid");
    }
    if (!Number.isSafeInteger(product.productCostMinor)
        || product.productCostMinor < 1
        || String(product.productCostMinor).length > 17) {
      throw new CrptWithdrawalPayloadError("Product cost must be positive kopecks");
    }
    const parsed = parseGs1MarkingCode(Buffer.from(product.markingCode));
    if (!parsed.ok || parsed.gtin !== product.gtin) {
      throw new CrptWithdrawalPayloadError("Marking code does not match withdrawal GTIN");
    }
    return {
      cis: extractIdentificationCode(product.markingCode),
      product_cost: product.productCostMinor,
    };
  }).sort((left, right) => left.cis.localeCompare(right.cis));
  if (new Set(products.map((product) => product.cis)).size !== products.length) {
    throw new CrptWithdrawalPayloadError("Withdrawal contains duplicate marking codes");
  }

  const document = {
    action: "DISTANCE",
    action_date: input.actionDate,
    document_date: input.actionDate,
    document_number: input.postingNumber,
    document_type: "OTHER",
    fias_id: input.fiasId,
    inn: input.inn,
    kpp: input.kpp,
    primary_document_custom_name: "Ozon FBS",
    products,
  } as const;
  return { document, bytes: Buffer.from(canonicalJson(document), "utf8") };
}
