import "server-only";

import { createHash } from "node:crypto";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import {
  consumeRemoteSignatureRequest,
  createRemoteSignatureRequest,
  getRemoteSignatureResult,
  type RemoteSignatureStatus,
} from "@/lib/marking/repositories/remote-signer";
import type { MarkingKeyring } from "@/lib/marking/security/keyring";
import type { MarkingSignerClient } from "@/lib/marking/signer/client";

export class RemoteSignerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RemoteSignerError";
  }
}

export function createRemoteMarkingSignerClient(input: {
  query: DatabaseQueryExecutor;
  keyring: MarkingKeyring;
  requestedBy?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): MarkingSignerClient {
  const requestedBy = input.requestedBy ?? "marking-worker";
  const timeoutMs = bounded(input.timeoutMs ?? 300_000, 5_000, 600_000);
  const pollIntervalMs = bounded(input.pollIntervalMs ?? 1_000, 250, 5_000);
  return {
    async sign(payload, purpose) {
      const plaintext = Buffer.from(payload);
      let encrypted;
      try {
        encrypted = input.keyring.encryptBytes(plaintext);
      } finally {
        plaintext.fill(0);
      }
      const created = await createRemoteSignatureRequest(input.query, {
        purpose,
        payloadSha256: createHash("sha256").update(payload).digest("hex"),
        encryptedPayload: encrypted,
        requestedBy,
        requestId: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + Math.min(840_000, timeoutMs + 60_000)),
      });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const result = await getRemoteSignatureResult(input.query, created.id, requestedBy);
        if (result.status === "signed" || result.status === "consumed") {
          if (!result.encryptedSignature || !result.certificate) {
            throw new RemoteSignerError(
              "signer_remote_result_invalid",
              "Remote signer result is incomplete",
              false,
            );
          }
          const signature = input.keyring.decryptBytes(result.encryptedSignature);
          try {
            if (result.status === "signed") {
              await consumeRemoteSignatureRequest(input.query, created.id, requestedBy);
            }
            return {
              signatureBase64: signature.toString("base64"),
              certificate: result.certificate,
            };
          } finally {
            signature.fill(0);
          }
        }
        if (result.status === "failed") {
          throw new RemoteSignerError(
            result.errorCode ?? "signer_remote_failed",
            result.errorMessage ?? "Remote signer failed",
            retryableStatus(result.status),
          );
        }
        if (result.status === "expired" || result.status === "cancelled") {
          throw new RemoteSignerError(
            `signer_remote_${result.status}`,
            `Remote signer request is ${result.status}`,
            true,
          );
        }
        await delay(pollIntervalMs);
      }
      throw new RemoteSignerError(
        "signer_remote_pending",
        "Mac signing agent has not completed the request yet",
        true,
      );
    },
  };
}

function retryableStatus(status: RemoteSignatureStatus) {
  return status === "pending" || status === "leased" || status === "expired";
}

function bounded(value: number, minimum: number, maximum: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.trunc(number))) : minimum;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
