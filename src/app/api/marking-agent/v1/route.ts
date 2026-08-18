import { NextRequest } from "next/server";
import {
  createAgentResponseAuth,
  MARKING_AGENT_API_PATH,
  MARKING_AGENT_OPERATIONS,
  MARKING_AGENT_PROTOCOL_VERSION,
  MarkingAgentProtocolError,
  parseAgentTelemetry,
  type MarkingAgentOperation,
} from "@/lib/marking/agent/protocol";
import { authenticateMarkingAgentRequest } from "@/lib/marking/agent/server-auth";
import { getMarkingRuntimeConfig } from "@/lib/marking/config";
import { isAdminFeatureEnabled } from "@/lib/admin/features";
import { queryServerDatabase } from "@/lib/db/pool";
import {
  acceptSigningAgentEnvelope,
  claimRemoteSignatureRequest,
  completeRemoteSignatureRequest,
  failRemoteSignatureRequest,
  getSignatureRequestSummary,
} from "@/lib/marking/repositories/remote-signer";
import { loadMarkingKeyring, type MarkingKeyring } from "@/lib/marking/security/keyring";
import { redactText } from "@/lib/marking/security/redaction";
import { isSignerCertificateInfo } from "@/lib/marking/signer/protocol";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 400_000;
let keyringPromise: Promise<MarkingKeyring> | null = null;
let keyringPath = "";
const agentRateLimits = new Map<string, { tokens: number; updatedAt: number }>();

export async function POST(request: NextRequest) {
  let secret: Buffer | null = null;
  let requestId: string | null = null;
  try {
    const bodyText = await readLimitedBody(request);
    const config = getMarkingRuntimeConfig();
    const authenticated = await authenticateMarkingAgentRequest({
      method: request.method,
      pathname: MARKING_AGENT_API_PATH,
      headers: request.headers,
      body: bodyText,
      secretsFile: config.agentSecretsFile,
    });
    secret = authenticated.secret;
    requestId = authenticated.envelope.requestId;
    assertAgentRateLimit(authenticated.envelope.agentId);
    if (!config.enabled || !config.signerEnabled || config.signerTransport !== "remote") {
      return signedJson({ ok: false, error: "agent_endpoint_disabled" }, 503, requestId, secret);
    }
    const body = parseRequestBody(bodyText);
    const featureEnabled = await isAdminFeatureEnabled("chestny_znak");
    await acceptSigningAgentEnvelope(queryServerDatabase, {
      agentId: authenticated.envelope.agentId,
      nonce: authenticated.envelope.nonce,
      requestId,
      issuedAt: authenticated.envelope.issuedAt,
      telemetry: body.telemetry,
    });
    if (body.operation === "heartbeat") {
      return signedJson({
        ok: true,
        operation: body.operation,
        featureEnabled,
        summary: await getSignatureRequestSummary(queryServerDatabase),
      }, 200, requestId, secret);
    }
    if (body.operation === "claim") {
      if (!featureEnabled) {
        return signedJson({
          ok: true,
          operation: body.operation,
          request: null,
        }, 200, requestId, secret);
      }
      const claimed = await claimRemoteSignatureRequest(
        queryServerDatabase,
        authenticated.envelope.agentId,
        90,
      );
      if (!claimed) {
        return signedJson({ ok: true, operation: body.operation, request: null }, 200, requestId, secret);
      }
      const keyring = await getKeyring(config.keyringFile);
      const payload = keyring.decryptBytes(claimed.encryptedPayload);
      try {
        return signedJson({
          ok: true,
          operation: body.operation,
          request: {
            id: claimed.id,
            purpose: claimed.purpose,
            payloadSha256: claimed.payloadSha256,
            payloadBase64: payload.toString("base64"),
            expiresAt: claimed.expiresAt,
          },
        }, 200, requestId, secret);
      } finally {
        payload.fill(0);
      }
    }
    const signatureRequestId = requiredUuid(body.signatureRequestId);
    if (body.operation === "complete") {
      const keyring = await getKeyring(config.keyringFile);
      if (!isSignerCertificateInfo(body.certificate)) {
        throw new MarkingAgentProtocolError("agent_certificate_invalid", "Signer certificate is invalid");
      }
      if (
        body.telemetry.certificateThumbprint !== body.certificate.thumbprint
        || body.telemetry.certificateValidTo !== body.certificate.validTo
        || (config.crptInn && body.certificate.inn !== config.crptInn)
      ) {
        throw new MarkingAgentProtocolError("agent_certificate_mismatch", "Signer certificate does not match agent configuration");
      }
      const signature = decodeCanonicalBase64(body.signatureBase64, 131_072);
      try {
        await completeRemoteSignatureRequest(queryServerDatabase, {
          agentId: authenticated.envelope.agentId,
          signatureRequestId,
          encryptedSignature: keyring.encryptBytes(signature),
          certificate: body.certificate,
        });
      } finally {
        signature.fill(0);
      }
      return signedJson({ ok: true, operation: body.operation, status: "signed" }, 200, requestId, secret);
    }
    const errorCode = safeErrorCode(body.errorCode);
    const errorMessage = safeErrorMessage(body.errorMessage);
    const status = await failRemoteSignatureRequest(queryServerDatabase, {
      agentId: authenticated.envelope.agentId,
      signatureRequestId,
      errorCode,
      errorMessage,
      retryable: body.retryable === true,
    });
    return signedJson({ ok: true, operation: body.operation, status }, 200, requestId, secret);
  } catch (error) {
    if (secret && requestId) {
      return signedJson({
        ok: false,
        error: error instanceof MarkingAgentProtocolError
          ? error.code.slice(0, 120)
          : "agent_request_failed",
      }, protocolStatus(error), requestId, secret);
    }
    return Response.json({ ok: false, error: "agent_auth_failed" }, {
      status: error instanceof MarkingAgentProtocolError && error.code === "agent_request_too_large"
        ? 413
        : 401,
      headers: { "cache-control": "no-store" },
    });
  } finally {
    secret?.fill(0);
  }
}

function signedJson(
  payload: Record<string, unknown>,
  status: number,
  requestId: string,
  secret: Uint8Array,
) {
  const body = JSON.stringify(payload);
  const authHeaders = createAgentResponseAuth({ status, requestId, body, secret });
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...authHeaders,
    },
  });
}

async function readLimitedBody(request: NextRequest) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_REQUEST_BYTES) {
    throw new MarkingAgentProtocolError("agent_request_too_large", "Agent request is too large");
  }
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    throw new MarkingAgentProtocolError("agent_request_too_large", "Agent request is too large");
  }
  return body;
}

function parseRequestBody(source: string) {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new MarkingAgentProtocolError("agent_request_invalid", "Agent request is invalid", { cause: error });
  }
  if (!isRecord(value) || value.version !== MARKING_AGENT_PROTOCOL_VERSION) {
    throw new MarkingAgentProtocolError("agent_request_invalid", "Agent request is invalid");
  }
  if (!(MARKING_AGENT_OPERATIONS as readonly unknown[]).includes(value.operation)) {
    throw new MarkingAgentProtocolError("agent_operation_invalid", "Agent operation is invalid");
  }
  assertRequestFields(value, value.operation as MarkingAgentOperation);
  return {
    operation: value.operation as MarkingAgentOperation,
    telemetry: parseAgentTelemetry(value.telemetry),
    signatureRequestId: value.signatureRequestId,
    signatureBase64: value.signatureBase64,
    certificate: value.certificate,
    errorCode: value.errorCode,
    errorMessage: value.errorMessage,
    retryable: value.retryable,
  };
}

function assertRequestFields(value: Record<string, unknown>, operation: MarkingAgentOperation) {
  const common = ["operation", "telemetry", "version"];
  const allowed = operation === "complete"
    ? [...common, "certificate", "signatureBase64", "signatureRequestId"]
    : operation === "fail"
      ? [...common, "errorCode", "errorMessage", "retryable", "signatureRequestId"]
      : common;
  const keys = Object.keys(value).sort();
  allowed.sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    throw new MarkingAgentProtocolError("agent_request_invalid", "Agent request fields are invalid");
  }
}

async function getKeyring(path: string) {
  if (!keyringPromise || keyringPath !== path) {
    keyringPath = path;
    keyringPromise = loadMarkingKeyring(path).catch((error) => {
      keyringPromise = null;
      throw error;
    });
  }
  return keyringPromise;
}

function requiredUuid(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new MarkingAgentProtocolError("agent_request_invalid", "Signature request ID is invalid");
  }
  return value;
}

function decodeCanonicalBase64(value: unknown, maximumBytes: number) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new MarkingAgentProtocolError("agent_signature_invalid", "Signature is invalid");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < 64 || decoded.length > maximumBytes || decoded.toString("base64") !== value) {
    decoded.fill(0);
    throw new MarkingAgentProtocolError("agent_signature_invalid", "Signature is invalid");
  }
  return decoded;
}

function safeErrorCode(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_:-]{2,120}$/.test(value)) {
    throw new MarkingAgentProtocolError("agent_error_invalid", "Signer error is invalid");
  }
  return value;
}

function safeErrorMessage(value: unknown) {
  if (typeof value !== "string") {
    throw new MarkingAgentProtocolError("agent_error_invalid", "Signer error is invalid");
  }
  const safe = redactText(value).slice(0, 500);
  if (!safe) throw new MarkingAgentProtocolError("agent_error_invalid", "Signer error is invalid");
  return safe;
}

function protocolStatus(error: unknown) {
  if (!(error instanceof MarkingAgentProtocolError)) return 500;
  if (error.code === "agent_request_too_large") return 413;
  if (error.code === "agent_auth_failed") return 401;
  if (error.code === "agent_rate_limited") return 429;
  return 400;
}

function assertAgentRateLimit(agentId: string) {
  const now = Date.now();
  const current = agentRateLimits.get(agentId) ?? { tokens: 120, updatedAt: now };
  current.tokens = Math.min(120, current.tokens + ((now - current.updatedAt) / 1_000) * 2);
  current.updatedAt = now;
  if (current.tokens < 1) {
    agentRateLimits.set(agentId, current);
    throw new MarkingAgentProtocolError("agent_rate_limited", "Agent request rate is too high");
  }
  current.tokens -= 1;
  agentRateLimits.set(agentId, current);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
