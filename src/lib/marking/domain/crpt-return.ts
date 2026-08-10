import { parseGs1MarkingCode } from "@/lib/marking/domain/code-pool";
import {
  canonicalJson,
  extractIdentificationCode,
} from "@/lib/marking/domain/crpt-introduction";

export const CRPT_RETURN_CONTRACT_VERSION =
  "true-api-lp-return-v649.0-2026-04-15";

export class CrptReturnPayloadError extends Error {
  readonly code = "crpt_return_payload_invalid";

  constructor(message: string) {
    super(message);
    this.name = "CrptReturnPayloadError";
  }
}

export function buildLpRemoteSaleReturnPayload(input: {
  inn: string;
  actionDate: string;
  returnReference: string;
  paid: boolean;
  gtin: string;
  markingCode: Uint8Array;
}) {
  if (!/^\d{10}(?:\d{2})?$/.test(input.inn)) {
    throw new CrptReturnPayloadError("INN is required for LP_RETURN");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.actionDate)) {
    throw new CrptReturnPayloadError("Return action date is invalid");
  }
  if (input.returnReference.length < 1 || input.returnReference.length > 300) {
    throw new CrptReturnPayloadError("Return reference is invalid");
  }
  if (!/^\d{14}$/.test(input.gtin)) {
    throw new CrptReturnPayloadError("Return GTIN is invalid");
  }
  const parsed = parseGs1MarkingCode(Buffer.from(input.markingCode));
  if (!parsed.ok || parsed.gtin !== input.gtin) {
    throw new CrptReturnPayloadError("Marking code does not match return GTIN");
  }

  const document = {
    trade_participant_inn: input.inn,
    return_type: "REMOTE_SALE_RETURN",
    paid: input.paid,
    ...(input.paid
      ? {
          primary_document_type: "OTHER",
          primary_document_number: input.returnReference,
          primary_document_date: input.actionDate,
          primary_document_custom_name: "Ozon FBS return",
        }
      : {}),
    products_list: [{ ki: extractIdentificationCode(input.markingCode) }],
  } as const;
  return {
    document,
    bytes: Buffer.from(canonicalJson(document), "utf8"),
  };
}
