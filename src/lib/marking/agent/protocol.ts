import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const MARKING_AGENT_PROTOCOL_VERSION = 1 as const;
export const MARKING_AGENT_API_PATH = "/api/marking-agent/v1";
export const MARKING_AGENT_OPERATIONS = ["heartbeat", "claim", "complete", "fail"] as const;
export type MarkingAgentOperation = (typeof MARKING_AGENT_OPERATIONS)[number];
export type MarkingAgentState =
  | "ready"
  | "degraded"
  | "token_missing"
  | "signer_unavailable"
  | "pin_required"
  | "offline";
export type MarkingAgentPinState = "unknown" | "ready" | "required" | "blocked";

export type MarkingAgentTelemetry = {
  displayName: string;
  state: MarkingAgentState;
  readerDetected: boolean;
  signerReachable: boolean;
  pinState: MarkingAgentPinState;
  certificateThumbprint: string | null;
  certificateValidTo: string | null;
  softwareVersion: string;
  errorCode: string | null;
  errorMessage: string | null;
};

export type MarkingAgentRequestBody = {
  version: typeof MARKING_AGENT_PROTOCOL_VERSION;
  operation: MarkingAgentOperation;
  telemetry: MarkingAgentTelemetry;
  signatureRequestId?: string;
  signatureBase64?: string;
  certificate?: unknown;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
};

export const AGENT_HEADERS = {
  agentId: "x-getomerch-agent-id",
  requestId: "x-getomerch-agent-request-id",
  issuedAt: "x-getomerch-agent-issued-at",
  nonce: "x-getomerch-agent-nonce",
  signature: "x-getomerch-agent-signature",
  responseIssuedAt: "x-getomerch-agent-response-issued-at",
  responseSignature: "x-getomerch-agent-response-signature",
} as const;

const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const CLOCK_TOLERANCE_MS = 90_000;

export class MarkingAgentProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MarkingAgentProtocolError";
  }
}

export function createAgentRequestAuth(input: {
  method: string;
  pathname: string;
  agentId: string;
  requestId?: string;
  issuedAt?: string;
  nonce?: string;
  body: string;
  secret: Uint8Array;
}) {
  const requestId = input.requestId ?? crypto.randomUUID();
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const nonce = input.nonce ?? randomBytes(16).toString("hex");
  validateEnvelope({ agentId: input.agentId, requestId, issuedAt, nonce }, Date.now());
  const digest = sha256(input.body);
  const signature = hmac(input.secret, canonicalRequest({
    method: input.method,
    pathname: input.pathname,
    agentId: input.agentId,
    requestId,
    issuedAt,
    nonce,
    digest,
  }));
  return {
    requestId,
    issuedAt,
    nonce,
    headers: {
      [AGENT_HEADERS.agentId]: input.agentId,
      [AGENT_HEADERS.requestId]: requestId,
      [AGENT_HEADERS.issuedAt]: issuedAt,
      [AGENT_HEADERS.nonce]: nonce,
      [AGENT_HEADERS.signature]: signature,
    },
  };
}

export function verifyAgentRequestAuth(input: {
  method: string;
  pathname: string;
  headers: Readonly<Record<string, string | undefined>>;
  body: string;
  secret: Uint8Array;
  now?: number;
}) {
  const agentId = requiredHeader(input.headers, AGENT_HEADERS.agentId);
  const requestId = requiredHeader(input.headers, AGENT_HEADERS.requestId);
  const issuedAt = requiredHeader(input.headers, AGENT_HEADERS.issuedAt);
  const nonce = requiredHeader(input.headers, AGENT_HEADERS.nonce);
  const signature = requiredHeader(input.headers, AGENT_HEADERS.signature);
  validateEnvelope({ agentId, requestId, issuedAt, nonce }, input.now ?? Date.now());
  if (!HEX_SHA256.test(signature)) {
    throw new MarkingAgentProtocolError("agent_auth_failed", "Agent authentication failed");
  }
  const expected = hmac(input.secret, canonicalRequest({
    method: input.method,
    pathname: input.pathname,
    agentId,
    requestId,
    issuedAt,
    nonce,
    digest: sha256(input.body),
  }));
  if (!safeEqual(signature, expected)) {
    throw new MarkingAgentProtocolError("agent_auth_failed", "Agent authentication failed");
  }
  return { agentId, requestId, issuedAt, nonce };
}

export function createAgentResponseAuth(input: {
  status: number;
  requestId: string;
  body: string;
  secret: Uint8Array;
  issuedAt?: string;
}) {
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  if (!UUID_PATTERN.test(input.requestId) || !Number.isFinite(Date.parse(issuedAt))) {
    throw new MarkingAgentProtocolError("agent_response_invalid", "Agent response metadata is invalid");
  }
  const signature = hmac(input.secret, canonicalResponse({
    status: input.status,
    requestId: input.requestId,
    issuedAt,
    digest: sha256(input.body),
  }));
  return {
    [AGENT_HEADERS.requestId]: input.requestId,
    [AGENT_HEADERS.responseIssuedAt]: issuedAt,
    [AGENT_HEADERS.responseSignature]: signature,
  };
}

export function verifyAgentResponseAuth(input: {
  status: number;
  expectedRequestId: string;
  headers: Readonly<Record<string, string | undefined>>;
  body: string;
  secret: Uint8Array;
  now?: number;
}) {
  const requestId = requiredHeader(input.headers, AGENT_HEADERS.requestId);
  const issuedAt = requiredHeader(input.headers, AGENT_HEADERS.responseIssuedAt);
  const signature = requiredHeader(input.headers, AGENT_HEADERS.responseSignature);
  if (requestId !== input.expectedRequestId || !UUID_PATTERN.test(requestId)) {
    throw new MarkingAgentProtocolError("agent_response_mismatch", "Agent response request ID mismatch");
  }
  const timestamp = Date.parse(issuedAt);
  if (!Number.isFinite(timestamp) || Math.abs((input.now ?? Date.now()) - timestamp) > CLOCK_TOLERANCE_MS) {
    throw new MarkingAgentProtocolError("agent_response_expired", "Agent response timestamp is outside the allowed window");
  }
  if (!HEX_SHA256.test(signature)) {
    throw new MarkingAgentProtocolError("agent_response_auth_failed", "Agent response authentication failed");
  }
  const expected = hmac(input.secret, canonicalResponse({
    status: input.status,
    requestId,
    issuedAt,
    digest: sha256(input.body),
  }));
  if (!safeEqual(signature, expected)) {
    throw new MarkingAgentProtocolError("agent_response_auth_failed", "Agent response authentication failed");
  }
}

export function parseAgentTelemetry(value: unknown): MarkingAgentTelemetry {
  if (!isRecord(value)) {
    throw new MarkingAgentProtocolError("agent_telemetry_invalid", "Agent telemetry is invalid");
  }
  const state = value.state;
  const pinState = value.pinState;
  const certificateThumbprint = nullableString(value.certificateThumbprint);
  const certificateValidTo = nullableString(value.certificateValidTo);
  const errorCode = nullableString(value.errorCode);
  const errorMessage = nullableString(value.errorMessage);
  if (
    typeof value.displayName !== "string" || value.displayName.length < 1 || value.displayName.length > 120
    || !["ready", "degraded", "token_missing", "signer_unavailable", "pin_required", "offline"].includes(String(state))
    || typeof value.readerDetected !== "boolean"
    || typeof value.signerReachable !== "boolean"
    || !["unknown", "ready", "required", "blocked"].includes(String(pinState))
    || typeof value.softwareVersion !== "string" || !/^[A-Za-z0-9._+-]{1,40}$/.test(value.softwareVersion)
    || certificateThumbprint === undefined
    || certificateValidTo === undefined
    || errorCode === undefined
    || errorMessage === undefined
    || (certificateThumbprint === null) !== (certificateValidTo === null)
    || (certificateThumbprint !== null && !/^[0-9A-F]{40,128}$/.test(certificateThumbprint))
    || (certificateValidTo !== null && !Number.isFinite(Date.parse(certificateValidTo)))
    || (errorCode !== null && !/^[A-Za-z0-9_:-]{2,120}$/.test(errorCode))
    || (errorMessage !== null && (errorMessage.length < 1 || errorMessage.length > 500))
  ) {
    throw new MarkingAgentProtocolError("agent_telemetry_invalid", "Agent telemetry is invalid");
  }
  return {
    displayName: value.displayName,
    state: state as MarkingAgentState,
    readerDetected: value.readerDetected,
    signerReachable: value.signerReachable,
    pinState: pinState as MarkingAgentPinState,
    certificateThumbprint,
    certificateValidTo,
    softwareVersion: value.softwareVersion,
    errorCode,
    errorMessage,
  };
}

export function decodeAgentSecret(source: string, name = "marking agent secret") {
  const normalized = source.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new MarkingAgentProtocolError("agent_secret_invalid", `${name} must be canonical base64`);
  }
  const secret = Buffer.from(normalized, "base64");
  if (secret.length < 32 || secret.length > 128 || secret.toString("base64") !== normalized) {
    secret.fill(0);
    throw new MarkingAgentProtocolError("agent_secret_invalid", `${name} must contain 32-128 bytes`);
  }
  return secret;
}

function canonicalRequest(input: {
  method: string;
  pathname: string;
  agentId: string;
  requestId: string;
  issuedAt: string;
  nonce: string;
  digest: string;
}) {
  return [
    MARKING_AGENT_PROTOCOL_VERSION,
    input.method.toUpperCase(),
    input.pathname,
    input.agentId,
    input.requestId,
    input.issuedAt,
    input.nonce,
    input.digest,
  ].join("\n");
}

function canonicalResponse(input: {
  status: number;
  requestId: string;
  issuedAt: string;
  digest: string;
}) {
  return [
    MARKING_AGENT_PROTOCOL_VERSION,
    input.status,
    input.requestId,
    input.issuedAt,
    input.digest,
  ].join("\n");
}

function validateEnvelope(input: {
  agentId: string;
  requestId: string;
  issuedAt: string;
  nonce: string;
}, now: number) {
  const timestamp = Date.parse(input.issuedAt);
  if (
    !AGENT_ID_PATTERN.test(input.agentId)
    || !UUID_PATTERN.test(input.requestId)
    || !NONCE_PATTERN.test(input.nonce)
    || !Number.isFinite(timestamp)
    || Math.abs(now - timestamp) > CLOCK_TOLERANCE_MS
  ) {
    throw new MarkingAgentProtocolError("agent_auth_failed", "Agent authentication failed");
  }
}

function requiredHeader(headers: Readonly<Record<string, string | undefined>>, name: string) {
  const value = headers[name]?.trim();
  if (!value) throw new MarkingAgentProtocolError("agent_auth_failed", "Agent authentication failed");
  return value;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(secret: Uint8Array, value: string) {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function nullableString(value: unknown) {
  return value === null ? null : typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
