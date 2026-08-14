import { parseGs1MarkingCode } from "@/lib/marking/domain/code-pool";

export const CRPT_INTRODUCTION_CONTRACT_VERSION = "true-api-v716.0-2026-08-12";

export const CRPT_CONFORMITY_DOCUMENT_TYPES = [
  "CONFORMITY_CERTIFICATE",
  "CONFORMITY_DECLARATION",
  "STATE_REGISTRATION_CERTIFICATE",
] as const;

export type CrptConformityDocumentType =
  (typeof CRPT_CONFORMITY_DOCUMENT_TYPES)[number];

export type CrptConformityDocument = {
  type: CrptConformityDocumentType;
  number: string;
  date: string;
};

export class CrptIntroductionPayloadError extends Error {
  readonly code = "crpt_introduction_payload_invalid";

  constructor(message: string) {
    super(message);
    this.name = "CrptIntroductionPayloadError";
  }
}

export function buildLpIntroduceGoodsPayload(input: {
  inn: string;
  gtin: string;
  tnvedCode: string;
  productionDate: string;
  markingCode: Uint8Array;
  conformityDocuments: readonly CrptConformityDocument[];
}) {
  if (!/^\d{10}(?:\d{2})?$/.test(input.inn)) {
    throw new CrptIntroductionPayloadError("INN is required for CRPT introduction");
  }
  if (!/^\d{14}$/.test(input.gtin) || !/^\d{4,10}$/.test(input.tnvedCode)) {
    throw new CrptIntroductionPayloadError("GTIN or TN VED is invalid");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.productionDate)) {
    throw new CrptIntroductionPayloadError("Production date is invalid");
  }
  if (input.conformityDocuments.length < 1 || input.conformityDocuments.length > 20) {
    throw new CrptIntroductionPayloadError("A conformity document is required for CRPT introduction");
  }
  const conformityDocuments = input.conformityDocuments.map((document) => {
    if (!CRPT_CONFORMITY_DOCUMENT_TYPES.includes(document.type)) {
      throw new CrptIntroductionPayloadError("Conformity document type is invalid");
    }
    const number = document.number.trim();
    if (number.length < 1 || number.length > 300 || /[\u0000-\u001f]/.test(number)) {
      throw new CrptIntroductionPayloadError("Conformity document number is invalid");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(document.date)) {
      throw new CrptIntroductionPayloadError("Conformity document date is invalid");
    }
    return {
      certificate_type: document.type,
      certificate_number: number,
      certificate_date: document.date,
    };
  });
  const parsed = parseGs1MarkingCode(Buffer.from(input.markingCode));
  if (!parsed.ok || parsed.gtin !== input.gtin) {
    throw new CrptIntroductionPayloadError("Marking code does not match the verified GTIN");
  }
  const uitCode = extractIdentificationCode(input.markingCode);
  const document = {
    owner_inn: input.inn,
    participant_inn: input.inn,
    producer_inn: input.inn,
    production_date: input.productionDate,
    production_type: "OWN_PRODUCTION",
    products: [{
      tnved_code: input.tnvedCode,
      uit_code: uitCode,
      certificate_document_data: conformityDocuments,
    }],
  } as const;
  return {
    document,
    bytes: Buffer.from(canonicalJson(document), "utf8"),
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CrptIntroductionPayloadError("Non-finite number in payload");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )).join(",")}}`;
  }
  throw new CrptIntroductionPayloadError("Unsupported value in canonical payload");
}

export function extractIdentificationCode(source: Uint8Array) {
  const code = Buffer.from(source);
  const offset = code.subarray(0, 3).equals(Buffer.from("]d2", "ascii")) ? 3 : 0;
  const separator = code.indexOf(0x1d, offset);
  if (separator < 0) {
    throw new CrptIntroductionPayloadError("Marking code does not contain a crypto-tail separator");
  }
  const value = code.subarray(offset, separator);
  if (value.length < 20 || value.length > 38 || !value.subarray(0, 2).equals(Buffer.from("01"))) {
    throw new CrptIntroductionPayloadError("Identification code has an invalid GS1 form");
  }
  return value.toString("ascii");
}
