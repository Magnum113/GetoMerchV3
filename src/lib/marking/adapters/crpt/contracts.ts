export type CrptCodeStatus = {
  requested: boolean;
  gtin: string | null;
  productGroup: string | null;
  status: string | null;
  statusEx: string | null;
  ownerInn: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type CrptDocumentStatus = {
  externalDocumentId: string;
  number: string | null;
  type: string | null;
  status: string;
  productGroup: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type CrptDocumentCreateResult = { externalDocumentId: string };

export type InternalCrptState =
  | "unknown"
  | "emitted"
  | "applied"
  | "introduced"
  | "in_circulation"
  | "withdrawn"
  | "invalid";

export class CrptContractError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CrptContractError";
  }
}

export function parseCrptAuthChallenge(value: unknown) {
  if (!isRecord(value)) throw invalid("CRPT auth challenge is not an object");
  const uuid = requiredString(value.uuid, "challenge uuid", 1, 200);
  const data = requiredString(value.data, "challenge data", 1, 32_768);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1) {
    throw invalid("CRPT auth challenge is not base64 data");
  }
  const padded = data.padEnd(Math.ceil(data.length / 4) * 4, "=");
  const bytes = Buffer.from(padded, "base64");
  if (bytes.length < 1 || bytes.length > 16_384) {
    bytes.fill(0);
    throw invalid("CRPT auth challenge size is invalid");
  }
  return { uuid, data, bytes };
}

export function parseCrptAuthToken(value: unknown, now = Date.now()) {
  if (!isRecord(value)) throw invalid("CRPT auth response is not an object");
  const token = optionalString(value.uuidToken, 8, 4096)
    ?? optionalString(value.token, 8, 8192);
  if (!token) throw invalid("CRPT auth response does not contain a token");
  const parsedExpiry = optionalDate(value.expireDate)
    ?? optionalDate(value.expiresAt)
    ?? optionalDate(value.expirationDate);
  const maximumExpiry = now + 10 * 60 * 60_000;
  const expiresAt = Math.min(parsedExpiry ?? maximumExpiry, maximumExpiry);
  if (expiresAt <= now + 60_000) throw invalid("CRPT auth token lifetime is too short");
  return { token, expiresAt };
}

export function parseCrptCodeInfo(value: unknown): CrptCodeStatus {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    throw invalid("CRPT code status response must contain exactly one item");
  }
  const row = value[0];
  const info = isRecord(row.cisInfo) ? row.cisInfo : row;
  return {
    requested: true,
    gtin: optionalString(info.gtin, 14, 14),
    productGroup: optionalString(info.productGroup, 1, 100),
    status: optionalString(info.status, 1, 120),
    statusEx: optionalString(info.statusEx, 1, 120),
    ownerInn: optionalString(info.ownerInn, 10, 12),
    errorCode: optionalString(row.errorCode, 1, 120),
    errorMessage: optionalString(row.errorMessage, 1, 500),
  };
}

export function parseCrptDocumentStatus(
  value: unknown,
  externalDocumentId: string,
): CrptDocumentStatus {
  if (Array.isArray(value) && value.length === 1) value = value[0];
  if (!isRecord(value)) throw invalid("CRPT document status response is not an object");
  const commonError = Array.isArray(value.commonErrors) && isRecord(value.commonErrors[0])
    ? value.commonErrors[0]
    : null;
  const firstError = Array.isArray(value.errors) && typeof value.errors[0] === "string"
    ? value.errors[0]
    : null;
  return {
    externalDocumentId,
    number: optionalString(value.number, 1, 300),
    type: optionalString(value.type, 1, 200),
    status: requiredString(value.status, "document status", 1, 120),
    productGroup: parseProductGroup(value.productGroup),
    errorCode: commonError ? optionalString(commonError.errorCode, 1, 120) : null,
    errorMessage: commonError
      ? optionalString(commonError.errorMessage, 1, 500) ?? optionalString(firstError, 1, 500)
      : optionalString(firstError, 1, 500),
  };
}

function parseProductGroup(value: unknown) {
  if (Array.isArray(value)) {
    if (value.length !== 1) throw invalid("CRPT response contains an invalid product group");
    return optionalString(value[0], 1, 100);
  }
  return optionalString(value, 1, 100);
}

export function parseCrptDocumentCreate(value: unknown): CrptDocumentCreateResult {
  if (!isRecord(value)) throw invalid("CRPT document create response is not an object");
  const id = requiredString(value.id, "document id", 1, 200);
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) throw invalid("CRPT document id is invalid");
  return { externalDocumentId: id };
}

export function normalizeCrptCodeState(status: string | null): InternalCrptState {
  const value = status?.trim().toUpperCase() ?? "";
  if (!value) return "unknown";
  if (/(INVALID|BLOCKED|DISAGGREGAT|REJECT|ERROR)/.test(value)) return "invalid";
  if (/(WITHDRAW|RETIRED|OUT_OF_CIRCULATION|WRITEOFF|WRITTEN_OFF)/.test(value)) return "withdrawn";
  if (/(IN_CIRCULATION|CIRCULATION)/.test(value)) return "in_circulation";
  if (/(INTRODUCED|INTRODUCTION)/.test(value)) return "introduced";
  if (/(APPLIED|MARKED)/.test(value)) return "applied";
  if (/(EMITTED|ISSUED|CREATED)/.test(value)) return "emitted";
  return "unknown";
}

export function isTerminalCrptDocumentStatus(status: string) {
  return ["CHECKED_OK", "CHECKED_NOT_OK", "PROCESSING_ERROR", "PARSE_ERROR"]
    .includes(status.trim().toUpperCase());
}

function invalid(message: string) {
  return new CrptContractError("crpt_contract_invalid", message);
}

function requiredString(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
) {
  const parsed = optionalString(value, minimum, maximum);
  if (!parsed) throw invalid(`CRPT ${name} is missing or invalid`);
  return parsed;
}

function optionalString(value: unknown, minimum: number, maximum: number) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw invalid("CRPT response contains an invalid string field");
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum || /[\u0000\r\n]/.test(normalized)) {
    throw invalid("CRPT response contains an invalid string field");
  }
  return normalized;
}

function optionalDate(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const date = Date.parse(String(value));
  if (!Number.isFinite(date)) throw invalid("CRPT token expiration is invalid");
  return date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
