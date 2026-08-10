import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

export const SIGNER_PROTOCOL_VERSION = 1 as const;
export const SIGNER_PURPOSES = [
  "crpt_auth_attached_cades_bes",
  "crpt_document_detached_cades_bes",
  "crpt_suz_order_detached_cades_bes",
] as const;
export type SignerPurpose = (typeof SIGNER_PURPOSES)[number];

export type SignerCertificateInfo = {
  thumbprint: string;
  subject: string;
  inn: string;
  ogrn: string | null;
  validFrom: string;
  validTo: string;
  algorithm: string;
};

export type SignerRequest = {
  version: typeof SIGNER_PROTOCOL_VERSION;
  requestId: string;
  issuedAt: string;
  caller: string;
  purpose: SignerPurpose;
  payloadBase64: string;
  payloadSha256: string;
  auth: string;
};

export type SignerSuccessResponse = {
  version: typeof SIGNER_PROTOCOL_VERSION;
  requestId: string;
  ok: true;
  purpose: SignerPurpose;
  payloadSha256: string;
  signatureBase64: string;
  certificate: SignerCertificateInfo;
  auth: string;
};

export type SignerErrorResponse = {
  version: typeof SIGNER_PROTOCOL_VERSION;
  requestId: string;
  ok: false;
  errorCode: string;
  errorMessage: string;
  auth: string;
};

export type SignerResponse = SignerSuccessResponse | SignerErrorResponse;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9._-]{1,80}$/;
const MAX_PAYLOAD_BYTES = 16_384;
const CLOCK_TOLERANCE_MS = 60_000;

export class SignerProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SignerProtocolError";
  }
}

export function createSignerRequest(input: {
  requestId: string;
  issuedAt: string;
  caller: string;
  purpose: SignerPurpose;
  payload: Uint8Array;
  secret: Uint8Array;
}): SignerRequest {
  const payload = Buffer.from(input.payload);
  try {
    const unsigned: Omit<SignerRequest, "auth"> = {
      version: SIGNER_PROTOCOL_VERSION,
      requestId: input.requestId,
      issuedAt: input.issuedAt,
      caller: input.caller,
      purpose: input.purpose,
      payloadBase64: payload.toString("base64"),
      payloadSha256: createHash("sha256").update(payload).digest("hex"),
    };
    validateUnsignedRequest(unsigned, new Date(input.issuedAt).getTime());
    return { ...unsigned, auth: requestMac(unsigned, input.secret) };
  } finally {
    payload.fill(0);
  }
}

export function verifySignerRequest(
  value: unknown,
  secret: Uint8Array,
  now = Date.now(),
): { request: SignerRequest; payload: Buffer } {
  const request = parseRequest(value);
  validateUnsignedRequest(request, now);
  if (!safeEqualHex(request.auth, requestMac(request, secret))) {
    throw new SignerProtocolError("signer_auth_failed", "Signer request authentication failed");
  }
  const payload = decodeCanonicalBase64(request.payloadBase64, MAX_PAYLOAD_BYTES);
  const digest = createHash("sha256").update(payload).digest("hex");
  if (!safeEqualHex(digest, request.payloadSha256)) {
    payload.fill(0);
    throw new SignerProtocolError("signer_digest_mismatch", "Signer payload digest mismatch");
  }
  return { request, payload };
}

export function createSignerSuccessResponse(
  input: Omit<SignerSuccessResponse, "version" | "ok" | "auth">,
  secret: Uint8Array,
): SignerSuccessResponse {
  const unsigned: Omit<SignerSuccessResponse, "auth"> = {
    version: SIGNER_PROTOCOL_VERSION,
    ok: true,
    ...input,
  };
  return { ...unsigned, auth: responseMac(unsigned, secret) };
}

export function createSignerErrorResponse(
  input: Omit<SignerErrorResponse, "version" | "ok" | "auth">,
  secret: Uint8Array,
): SignerErrorResponse {
  const unsigned: Omit<SignerErrorResponse, "auth"> = {
    version: SIGNER_PROTOCOL_VERSION,
    ok: false,
    ...input,
  };
  return { ...unsigned, auth: responseMac(unsigned, secret) };
}

export function verifySignerResponse(
  value: unknown,
  expected: { requestId: string; purpose: SignerPurpose; payloadSha256: string },
  secret: Uint8Array,
): SignerResponse {
  if (!isRecord(value) || value.version !== 1 || typeof value.ok !== "boolean") {
    throw new SignerProtocolError("signer_response_invalid", "Signer response is invalid");
  }
  const response = value as unknown as SignerResponse;
  if (response.requestId !== expected.requestId || !UUID_PATTERN.test(response.requestId)) {
    throw new SignerProtocolError("signer_response_mismatch", "Signer response request ID mismatch");
  }
  if (typeof response.auth !== "string" || !HEX_SHA256.test(response.auth)) {
    throw new SignerProtocolError("signer_response_invalid", "Signer response MAC is invalid");
  }
  const { auth: _auth, ...unsigned } = response;
  if (!safeEqualHex(response.auth, responseMac(unsigned, secret))) {
    throw new SignerProtocolError("signer_response_auth_failed", "Signer response authentication failed");
  }
  if (!response.ok) {
    if (
      typeof response.errorCode !== "string"
      || typeof response.errorMessage !== "string"
      || response.errorCode.length > 120
      || response.errorMessage.length > 500
    ) {
      throw new SignerProtocolError("signer_response_invalid", "Signer error response is invalid");
    }
    return response;
  }
  if (
    response.purpose !== expected.purpose
    || response.payloadSha256 !== expected.payloadSha256
    || !isSignerCertificateInfo(response.certificate)
  ) {
    throw new SignerProtocolError("signer_response_mismatch", "Signer response does not match request");
  }
  decodeCanonicalBase64(response.signatureBase64, 131_072).fill(0);
  return response;
}

export function decodeSignerSecret(source: string, name = "signer secret") {
  const secret = decodeCanonicalBase64(source.trim(), 128);
  if (secret.length < 32) {
    secret.fill(0);
    throw new SignerProtocolError("signer_secret_invalid", `${name} must contain at least 32 bytes`);
  }
  return secret;
}

function parseRequest(value: unknown): SignerRequest {
  if (!isRecord(value)) {
    throw new SignerProtocolError("signer_request_invalid", "Signer request must be an object");
  }
  const keys = Object.keys(value).sort();
  const expected = [
    "auth", "caller", "issuedAt", "payloadBase64", "payloadSha256",
    "purpose", "requestId", "version",
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new SignerProtocolError("signer_request_invalid", "Signer request fields are invalid");
  }
  return value as unknown as SignerRequest;
}

function validateUnsignedRequest(
  request: Omit<SignerRequest, "auth"> | SignerRequest,
  now: number,
) {
  if (request.version !== SIGNER_PROTOCOL_VERSION) {
    throw new SignerProtocolError("signer_version_unsupported", "Signer protocol version is unsupported");
  }
  if (!UUID_PATTERN.test(request.requestId)) {
    throw new SignerProtocolError("signer_request_invalid", "Signer request ID is invalid");
  }
  const issuedAt = Date.parse(request.issuedAt);
  if (!Number.isFinite(issuedAt) || Math.abs(now - issuedAt) > CLOCK_TOLERANCE_MS) {
    throw new SignerProtocolError("signer_request_expired", "Signer request timestamp is outside the allowed window");
  }
  if (!IDENTIFIER.test(request.caller)) {
    throw new SignerProtocolError("signer_caller_invalid", "Signer caller is invalid");
  }
  if (!(SIGNER_PURPOSES as readonly string[]).includes(request.purpose)) {
    throw new SignerProtocolError("signer_purpose_denied", "Signer purpose is not allowed");
  }
  if (!HEX_SHA256.test(request.payloadSha256)) {
    throw new SignerProtocolError("signer_request_invalid", "Signer payload digest is invalid");
  }
  if (typeof request.payloadBase64 !== "string" || request.payloadBase64.length > 24_000) {
    throw new SignerProtocolError("signer_payload_too_large", "Signer payload is too large");
  }
}

function requestMac(request: Omit<SignerRequest, "auth"> | SignerRequest, secret: Uint8Array) {
  return createHmac("sha256", secret).update([
    request.version,
    request.requestId,
    request.issuedAt,
    request.caller,
    request.purpose,
    request.payloadSha256,
    request.payloadBase64,
  ].join("\n")).digest("hex");
}

function responseMac(
  response: Omit<SignerSuccessResponse, "auth"> | Omit<SignerErrorResponse, "auth">,
  secret: Uint8Array,
) {
  const body = response.ok
    ? [
        response.version, response.requestId, "ok", response.purpose,
        response.payloadSha256, response.signatureBase64,
        response.certificate.thumbprint, response.certificate.subject,
        response.certificate.inn, response.certificate.ogrn ?? "",
        response.certificate.validFrom, response.certificate.validTo,
        response.certificate.algorithm,
      ]
    : [response.version, response.requestId, "error", response.errorCode, response.errorMessage];
  return createHmac("sha256", secret).update(body.join("\n")).digest("hex");
}

function decodeCanonicalBase64(value: string, maximumBytes: number) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new SignerProtocolError("signer_base64_invalid", "Signer value is not canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < 1 || decoded.length > maximumBytes || decoded.toString("base64") !== value) {
    decoded.fill(0);
    throw new SignerProtocolError("signer_base64_invalid", "Signer value is not canonical base64");
  }
  return decoded;
}

function safeEqualHex(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function isSignerCertificateInfo(value: unknown): value is SignerCertificateInfo {
  if (!isRecord(value)) return false;
  return typeof value.thumbprint === "string"
    && /^[0-9A-F]{40,128}$/.test(value.thumbprint)
    && typeof value.subject === "string" && value.subject.length >= 1 && value.subject.length <= 500
    && typeof value.inn === "string" && /^\d{10}(?:\d{2})?$/.test(value.inn)
    && (value.ogrn === null || (typeof value.ogrn === "string" && /^\d{13}(?:\d{2})?$/.test(value.ogrn)))
    && typeof value.validFrom === "string" && Number.isFinite(Date.parse(value.validFrom))
    && typeof value.validTo === "string" && Number.isFinite(Date.parse(value.validTo))
    && Date.parse(value.validTo) > Date.parse(value.validFrom)
    && Date.parse(value.validTo) > Date.now()
    && typeof value.algorithm === "string" && value.algorithm.length >= 1 && value.algorithm.length <= 200
    && /GOST|ГОСТ|34\.10-2012/i.test(value.algorithm);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
