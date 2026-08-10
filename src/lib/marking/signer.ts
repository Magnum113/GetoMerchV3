import "server-only";

import { hostname } from "node:os";
import { chmod, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer, type Socket } from "node:net";
import { getMarkingRuntimeConfig } from "@/lib/marking/config";
import { safeErrorForLog } from "@/lib/marking/security/redaction";
import {
  createSignerErrorResponse,
  createSignerSuccessResponse,
  decodeSignerSecret,
  SignerProtocolError,
  verifySignerRequest,
  type SignerRequest,
} from "@/lib/marking/signer/protocol";
import {
  createCommandSignatureProvider,
  MarkingSignatureProviderError,
  type MarkingSignatureProvider,
} from "@/lib/marking/signer/provider";

const MAX_REQUEST_BYTES = 64_000;

export async function runMarkingSigner() {
  const config = getMarkingRuntimeConfig();
  if (!config.enabled || !config.signerEnabled) {
    await runDisabledLoop();
    return;
  }

  const runtimeDirectory = dirname(config.signerSocketPath);
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o750 });
  await removeStaleSocket(config.signerSocketPath);
  const clients = await loadSignerClients(config.signerClientsFile);
  const provider = await createCommandSignatureProvider({
    command: config.signerProviderCommand,
    argsJson: process.env.GETOMERCH_MARKING_SIGNER_PROVIDER_ARGS_JSON,
    certificateFile: config.signerCertificateFile,
    expectedInn: config.crptInn || undefined,
    runtimeDirectory,
  });
  const replay = new SignerReplayGuard();
  const signerId = `${hostname()}:${process.pid}:signer`;
  const server = createServer((socket) => handleSocket(socket, clients, provider, replay));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.signerSocketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(config.signerSocketPath, 0o660);
  console.log("[marking-signer] ready", {
    signerId,
    certificateThumbprint: provider.certificate.thumbprint,
    certificateValidTo: provider.certificate.validTo,
    clientCount: clients.size,
  });

  await waitForStop(server);
  await unlink(config.signerSocketPath).catch(() => undefined);
  for (const secret of clients.values()) secret.fill(0);
  console.log("[marking-signer] stopped", { signerId });
}

export async function processSignerRequest(input: {
  value: unknown;
  clients: ReadonlyMap<string, Buffer>;
  provider: MarkingSignatureProvider;
  replay: SignerReplayGuard;
  now?: number;
}) {
  const requestHint = input.value && typeof input.value === "object"
    ? input.value as Partial<SignerRequest>
    : {};
  const caller = typeof requestHint.caller === "string" ? requestHint.caller : "";
  const secret = input.clients.get(caller);
  if (!secret) {
    throw new SignerProtocolError("signer_caller_denied", "Signer caller is not allowed");
  }
  const requestId = typeof requestHint.requestId === "string" && requestHint.requestId.length <= 80
    ? requestHint.requestId
    : crypto.randomUUID();
  let payload: Buffer | null = null;
  try {
    const verified = verifySignerRequest(input.value, secret, input.now);
    payload = verified.payload;
    if (!input.replay.accept(verified.request.requestId, input.now)) {
      throw new SignerProtocolError("signer_replay_detected", "Signer request ID was already used");
    }
    const signature = await input.provider.sign(payload, verified.request.purpose);
    try {
      return createSignerSuccessResponse({
        requestId: verified.request.requestId,
        purpose: verified.request.purpose,
        payloadSha256: verified.request.payloadSha256,
        signatureBase64: signature.toString("base64"),
        certificate: input.provider.certificate,
      }, secret);
    } finally {
      signature.fill(0);
    }
  } catch (error) {
    const safe = signerError(error);
    return createSignerErrorResponse({
      requestId,
      errorCode: safe.code,
      errorMessage: safe.message,
    }, secret);
  } finally {
    payload?.fill(0);
  }
}

export class SignerReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maximumEntries = 10_000,
  ) {}

  accept(requestId: string, now = Date.now()) {
    this.prune(now);
    if (this.seen.has(requestId)) return false;
    this.seen.set(requestId, now + this.ttlMs);
    if (this.seen.size > this.maximumEntries) {
      const oldest = this.seen.keys().next().value as string | undefined;
      if (oldest) this.seen.delete(oldest);
    }
    return true;
  }

  private prune(now: number) {
    for (const [requestId, expiresAt] of this.seen) {
      if (expiresAt > now) break;
      this.seen.delete(requestId);
    }
  }
}

async function handleSocket(
  socket: Socket,
  clients: ReadonlyMap<string, Buffer>,
  provider: MarkingSignatureProvider,
  replay: SignerReplayGuard,
) {
  socket.setEncoding("utf8");
  socket.setTimeout(20_000, () => socket.destroy());
  let body = "";
  let handled = false;
  socket.on("data", (chunk) => {
    if (handled) return;
    body += chunk;
    if (body.length > MAX_REQUEST_BYTES) {
      handled = true;
      socket.destroy();
      return;
    }
    const newline = body.indexOf("\n");
    if (newline < 0) return;
    handled = true;
    const line = body.slice(0, newline);
    void respond(socket, line, clients, provider, replay);
  });
  socket.once("error", (error) => {
    console.error("[marking-signer] socket error", safeErrorForLog(error));
  });
}

async function respond(
  socket: Socket,
  line: string,
  clients: ReadonlyMap<string, Buffer>,
  provider: MarkingSignatureProvider,
  replay: SignerReplayGuard,
) {
  try {
    const value = JSON.parse(line) as unknown;
    const response = await processSignerRequest({ value, clients, provider, replay });
    socket.end(`${JSON.stringify(response)}\n`);
  } catch (error) {
    console.error("[marking-signer] rejected request", safeErrorForLog(error));
    socket.destroy();
  }
}

async function loadSignerClients(path: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new SignerProtocolError("signer_clients_unavailable", "Signer clients file is unavailable", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SignerProtocolError("signer_clients_invalid", "Signer clients file is invalid");
  }
  const source = (parsed as { clients?: unknown }).clients;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new SignerProtocolError("signer_clients_invalid", "Signer clients map is invalid");
  }
  const entries = Object.entries(source as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 20) {
    throw new SignerProtocolError("signer_clients_invalid", "Signer clients map size is invalid");
  }
  const clients = new Map<string, Buffer>();
  for (const [caller, value] of entries) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(caller) || typeof value !== "string") {
      throw new SignerProtocolError("signer_clients_invalid", "Signer client entry is invalid");
    }
    clients.set(caller, decodeSignerSecret(value, `signer client ${caller}`));
  }
  return clients;
}

function signerError(error: unknown) {
  if (error instanceof SignerProtocolError || error instanceof MarkingSignatureProviderError) {
    return { code: error.code, message: error.message };
  }
  return { code: "signer_internal_error", message: "Signer failed to process the request" };
}

async function removeStaleSocket(path: string) {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return;
  if (!info.isSocket()) {
    throw new SignerProtocolError("signer_socket_unsafe", "Signer socket path exists and is not a socket");
  }
  await unlink(path);
}

async function waitForStop(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      server.close(() => resolve());
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
}

async function runDisabledLoop() {
  const signerId = `${hostname()}:${process.pid}:signer`;
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  console.log("[marking-signer] disabled", { signerId });
  while (!stopping) await new Promise((resolve) => setTimeout(resolve, 5_000));
  console.log("[marking-signer] stopped", { signerId });
}
