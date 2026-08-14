import {
  SIGNER_PURPOSES,
  type SignerPurpose,
} from "@/lib/marking/signer/protocol";

export type MarkingAgentClaim = {
  id: string;
  purpose: SignerPurpose;
  payloadSha256: string;
  payloadBase64: string;
  expiresAt: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function parseMarkingAgentClaim(
  value: unknown,
  operation: "heartbeat" | "claim",
): MarkingAgentClaim | null {
  if (!isRecord(value) || value.ok !== true || value.operation !== operation) {
    throw invalidResponse();
  }
  if (operation === "heartbeat" || value.request === null) return null;
  if (!isRecord(value.request)) throw invalidResponse();

  const request = value.request;
  if (
    typeof request.id !== "string"
    || !UUID_PATTERN.test(request.id)
    || !isSignerPurpose(request.purpose)
    || typeof request.payloadSha256 !== "string"
    || !SHA256_PATTERN.test(request.payloadSha256)
    || typeof request.payloadBase64 !== "string"
    || typeof request.expiresAt !== "string"
    || !Number.isFinite(Date.parse(request.expiresAt))
  ) {
    throw invalidResponse();
  }
  return request as MarkingAgentClaim;
}

function isSignerPurpose(value: unknown): value is SignerPurpose {
  return typeof value === "string"
    && (SIGNER_PURPOSES as readonly string[]).includes(value);
}

function invalidResponse() {
  return Object.assign(new Error("Marking server response is invalid"), {
    code: "agent_response_invalid",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
