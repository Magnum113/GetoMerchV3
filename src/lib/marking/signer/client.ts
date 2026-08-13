import "server-only";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import {
  createSignerRequest,
  decodeSignerSecret,
  SignerProtocolError,
  verifySignerResponse,
  type SignerCertificateInfo,
  type SignerPurpose,
} from "@/lib/marking/signer/protocol";

export type MarkingSignerClient = {
  sign(payload: Uint8Array, purpose: SignerPurpose): Promise<{
    signatureBase64: string;
    certificate: SignerCertificateInfo;
  }>;
};

export function createMarkingSignerClient(input: {
  socketPath: string;
  caller: string;
  secret: Uint8Array;
  timeoutMs?: number;
}): MarkingSignerClient {
  const secret = Buffer.from(input.secret);
  return {
    async sign(payload, purpose) {
      const request = createSignerRequest({
        requestId: crypto.randomUUID(),
        issuedAt: new Date().toISOString(),
        caller: input.caller,
        purpose,
        payload,
        secret,
      });
      const response = await exchangeSignerRequest(
        input.socketPath,
        request,
        input.timeoutMs ?? 80_000,
      );
      const verified = verifySignerResponse(response, {
        requestId: request.requestId,
        purpose,
        payloadSha256: createHash("sha256").update(payload).digest("hex"),
      }, secret);
      if (!verified.ok) {
        throw new SignerProtocolError(verified.errorCode, verified.errorMessage);
      }
      return {
        signatureBase64: verified.signatureBase64,
        certificate: verified.certificate,
      };
    },
  };
}

export async function loadMarkingSignerClient(input: {
  socketPath: string;
  caller: string;
  secretFile: string;
  timeoutMs?: number;
}) {
  let source: string;
  try {
    source = await readFile(input.secretFile, "utf8");
  } catch (error) {
    throw new SignerProtocolError("signer_credential_unavailable", "Signer client credential is unavailable", { cause: error });
  }
  const secret = decodeSignerSecret(source, "signer client secret");
  try {
    return createMarkingSignerClient({ ...input, secret });
  } finally {
    secret.fill(0);
  }
}

export function exchangeSignerRequest(socketPath: string, request: unknown, timeoutMs: number) {
  return new Promise<unknown>((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let settled = false;
    let body = "";
    const finish = (error?: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new SignerProtocolError("signer_timeout", "Signer request timed out")),
      Math.max(1_000, Math.min(80_000, timeoutMs)),
    );
    socket.setEncoding("utf8");
    // Keep the writable side open until the signer finishes its asynchronous work.
    // Calling socket.end() here makes a default Unix server close its response side.
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      body += chunk;
      if (body.length > 200_000) {
        finish(new SignerProtocolError("signer_response_too_large", "Signer response is too large"));
      }
    });
    socket.once("error", (error) => finish(new SignerProtocolError("signer_unavailable", "Signer socket is unavailable", { cause: error })));
    socket.once("end", () => {
      try {
        finish(undefined, JSON.parse(body.trim()));
      } catch (error) {
        finish(new SignerProtocolError("signer_response_invalid", "Signer returned invalid JSON", { cause: error }));
      }
    });
  });
}
