#!/usr/bin/env node

import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  loadMarkingAgentSecret,
  sendMarkingAgentRequest,
} from "@/lib/marking/agent/client";
import {
  MARKING_AGENT_PROTOCOL_VERSION,
  type MarkingAgentRequestBody,
  type MarkingAgentTelemetry,
} from "@/lib/marking/agent/protocol";
import { loadMarkingSignerClient } from "@/lib/marking/signer/client";
import { loadCertificateInfo } from "@/lib/marking/signer/provider";

const AGENT_VERSION = "1.0.0";

type AgentConfig = ReturnType<typeof loadConfig>;
type AgentRuntime = {
  pinState: MarkingAgentTelemetry["pinState"];
  lastError: { code: string; message: string } | null;
  cardProbe: { detected: boolean; checkedAt: number };
};

async function main() {
  const config = loadConfig(process.env);
  const secret = await loadMarkingAgentSecret(config.agentSecretFile);
  const certificate = await loadCertificateInfo(config.certificateFile, config.expectedInn || undefined);
  const signer = await loadMarkingSignerClient({
    socketPath: config.signerSocketPath,
    caller: config.signerClientId,
    secretFile: config.signerClientSecretFile,
    timeoutMs: 70_000,
  });
  const runtime: AgentRuntime = {
    pinState: "unknown",
    lastError: null,
    cardProbe: { detected: false, checkedAt: 0 },
  };
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log("[marking-mac-agent] started", {
    agentId: config.agentId,
    server: new URL(config.serverUrl).origin,
    certificateThumbprint: certificate.thumbprint,
    certificateValidTo: certificate.validTo,
  });
  try {
    while (!controller.signal.aborted) {
      try {
        const telemetry = await collectTelemetry(config, runtime, certificate);
        const operation = telemetry.readerDetected && telemetry.signerReachable
          ? "claim"
          : "heartbeat";
        const response = await sendMarkingAgentRequest({
          serverUrl: config.serverUrl,
          agentId: config.agentId,
          secret,
          body: {
            version: MARKING_AGENT_PROTOCOL_VERSION,
            operation,
            telemetry,
          },
        });
        const claimed = parseClaim(response, operation);
        if (claimed) {
          await processClaim({ config, runtime, secret, signer, certificate, claimed });
        }
        if (runtime.lastError?.code === "agent_server_unavailable") runtime.lastError = null;
      } catch (error) {
        runtime.lastError = safeError(error);
        console.error("[marking-mac-agent] cycle failed", runtime.lastError);
      }
      await delay(config.pollIntervalMs, controller.signal);
    }
  } finally {
    secret.fill(0);
    console.log("[marking-mac-agent] stopped", { agentId: config.agentId });
  }
}

async function processClaim(input: {
  config: AgentConfig;
  runtime: AgentRuntime;
  secret: Uint8Array;
  signer: Awaited<ReturnType<typeof loadMarkingSignerClient>>;
  certificate: Awaited<ReturnType<typeof loadCertificateInfo>>;
  claimed: {
    id: string;
    purpose: "crpt_auth_attached_cades_bes";
    payloadSha256: string;
    payloadBase64: string;
    expiresAt: string;
  };
}) {
  const payload = decodePayload(input.claimed.payloadBase64);
  try {
    const digest = createHash("sha256").update(payload).digest("hex");
    if (digest !== input.claimed.payloadSha256 || Date.parse(input.claimed.expiresAt) <= Date.now()) {
      throw codedError("agent_claim_invalid", "Signing request is invalid or expired");
    }
    input.runtime.pinState = "required";
    input.runtime.lastError = null;
    await sendSigningHeartbeat(input).catch((error) => {
      console.error("[marking-mac-agent] signing heartbeat failed", safeError(error));
    });
    const result = await withSigningHeartbeats(
      input,
      () => input.signer.sign(payload, input.claimed.purpose),
    );
    if (result.certificate.thumbprint !== input.certificate.thumbprint) {
      throw codedError("agent_certificate_mismatch", "Local signer used an unexpected certificate");
    }
    input.runtime.pinState = "ready";
    input.runtime.lastError = null;
    await sendResult(input, {
      version: MARKING_AGENT_PROTOCOL_VERSION,
      operation: "complete",
      telemetry: await collectTelemetry(input.config, input.runtime, input.certificate),
      signatureRequestId: input.claimed.id,
      signatureBase64: result.signatureBase64,
      certificate: result.certificate,
    });
    console.log("[marking-mac-agent] signature completed", {
      signatureRequestId: input.claimed.id,
      certificateThumbprint: result.certificate.thumbprint,
    });
  } catch (error) {
    const safe = safeError(error);
    input.runtime.lastError = safe;
    input.runtime.pinState = pinStateForError(safe.code, input.runtime.pinState);
    await sendResult(input, {
      version: MARKING_AGENT_PROTOCOL_VERSION,
      operation: "fail",
      telemetry: await collectTelemetry(input.config, input.runtime, input.certificate),
      signatureRequestId: input.claimed.id,
      errorCode: safe.code,
      errorMessage: safe.message,
      retryable: retryableSignerError(safe.code),
    }).catch((reportError) => {
      console.error("[marking-mac-agent] unable to report signer failure", safeError(reportError));
    });
  } finally {
    payload.fill(0);
  }
}

async function withSigningHeartbeats<T>(
  input: Parameters<typeof processClaim>[0],
  operation: () => Promise<T>,
) {
  let inFlight: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = sendSigningHeartbeat(input)
      .catch((error) => {
        console.error("[marking-mac-agent] signing heartbeat failed", safeError(error));
      })
      .finally(() => { inFlight = null; });
  }, 10_000);
  try {
    return await operation();
  } finally {
    clearInterval(timer);
    await inFlight;
  }
}

async function sendSigningHeartbeat(input: Parameters<typeof processClaim>[0]) {
  return sendResult(input, {
    version: MARKING_AGENT_PROTOCOL_VERSION,
    operation: "heartbeat",
    telemetry: {
      displayName: input.config.displayName,
      state: "pin_required",
      readerDetected: input.runtime.cardProbe.detected,
      signerReachable: true,
      pinState: "required",
      certificateThumbprint: input.certificate.thumbprint,
      certificateValidTo: input.certificate.validTo,
      softwareVersion: AGENT_VERSION,
      errorCode: null,
      errorMessage: null,
    },
  });
}

async function sendResult(
  input: {
    config: AgentConfig;
    secret: Uint8Array;
  },
  body: MarkingAgentRequestBody,
) {
  return sendMarkingAgentRequest({
    serverUrl: input.config.serverUrl,
    agentId: input.config.agentId,
    secret: input.secret,
    body,
    timeoutMs: 20_000,
  });
}

async function collectTelemetry(
  config: AgentConfig,
  runtime: AgentRuntime,
  certificate: Awaited<ReturnType<typeof loadCertificateInfo>>,
): Promise<MarkingAgentTelemetry> {
  const now = Date.now();
  if (now - runtime.cardProbe.checkedAt >= config.cardProbeIntervalMs) {
    runtime.cardProbe = {
      detected: await probeRutoken(config.tokenProbeCommand),
      checkedAt: now,
    };
  }
  const signerReachable = await signerSocketExists(config.signerSocketPath);
  const state = !runtime.cardProbe.detected
    ? "token_missing"
    : !signerReachable
      ? "signer_unavailable"
      : runtime.pinState === "required" || runtime.pinState === "blocked"
        ? "pin_required"
        : runtime.lastError
          ? "degraded"
          : "ready";
  return {
    displayName: config.displayName,
    state,
    readerDetected: runtime.cardProbe.detected,
    signerReachable,
    pinState: runtime.pinState,
    certificateThumbprint: certificate.thumbprint,
    certificateValidTo: certificate.validTo,
    softwareVersion: AGENT_VERSION,
    errorCode: runtime.lastError?.code ?? null,
    errorMessage: runtime.lastError?.message ?? null,
  };
}

async function probeRutoken(command: string) {
  try {
    const args = command.endsWith("/certmgr")
      ? ["-list", "-store", "uMy"]
      : ["-card", "-enum"];
    const output = await exec(command, args);
    return /SCARD\\|rutoken|рутокен|PrivateKey Link\s*:\s*Yes/i.test(output);
  } catch {
    return false;
  }
}

async function signerSocketExists(path: string) {
  try {
    return (await lstat(path)).isSocket();
  } catch {
    return false;
  }
}

function parseClaim(value: unknown, operation: "heartbeat" | "claim") {
  if (!isRecord(value) || value.ok !== true || value.operation !== operation) {
    throw codedError("agent_response_invalid", "Marking server response is invalid");
  }
  if (operation === "heartbeat" || value.request === null) return null;
  if (!isRecord(value.request)) {
    throw codedError("agent_response_invalid", "Marking server response is invalid");
  }
  const request = value.request;
  if (
    typeof request.id !== "string"
    || !/^[0-9a-f-]{36}$/i.test(request.id)
    || request.purpose !== "crpt_auth_attached_cades_bes"
    || typeof request.payloadSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(request.payloadSha256)
    || typeof request.payloadBase64 !== "string"
    || typeof request.expiresAt !== "string"
    || !Number.isFinite(Date.parse(request.expiresAt))
  ) {
    throw codedError("agent_response_invalid", "Marking server response is invalid");
  }
  return request as {
    id: string;
    purpose: "crpt_auth_attached_cades_bes";
    payloadSha256: string;
    payloadBase64: string;
    expiresAt: string;
  };
}

function decodePayload(value: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw codedError("agent_claim_invalid", "Signing payload is invalid");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < 1 || decoded.length > 16_384 || decoded.toString("base64") !== value) {
    decoded.fill(0);
    throw codedError("agent_claim_invalid", "Signing payload is invalid");
  }
  return decoded;
}

function loadConfig(env: Readonly<Record<string, string | undefined>>) {
  return {
    serverUrl: required(env.GETOMERCH_MARKING_AGENT_SERVER_URL, "GETOMERCH_MARKING_AGENT_SERVER_URL"),
    agentId: identifier(env.GETOMERCH_MARKING_AGENT_ID ?? "macbook-marking", "GETOMERCH_MARKING_AGENT_ID"),
    displayName: text(env.GETOMERCH_MARKING_AGENT_DISPLAY_NAME ?? hostname(), "GETOMERCH_MARKING_AGENT_DISPLAY_NAME", 120),
    agentSecretFile: absolute(env.GETOMERCH_MARKING_AGENT_SECRET_FILE, "GETOMERCH_MARKING_AGENT_SECRET_FILE"),
    signerSocketPath: absolute(
      env.GETOMERCH_MARKING_SIGNER_SOCKET ?? join(tmpdir(), "getomerch-marking", "signer.sock"),
      "GETOMERCH_MARKING_SIGNER_SOCKET",
    ),
    signerClientId: identifier(env.GETOMERCH_MARKING_SIGNER_CLIENT_ID ?? "marking-mac-agent", "GETOMERCH_MARKING_SIGNER_CLIENT_ID"),
    signerClientSecretFile: absolute(env.GETOMERCH_MARKING_SIGNER_CLIENT_SECRET_FILE, "GETOMERCH_MARKING_SIGNER_CLIENT_SECRET_FILE"),
    certificateFile: absolute(env.GETOMERCH_MARKING_SIGNER_CERTIFICATE_FILE, "GETOMERCH_MARKING_SIGNER_CERTIFICATE_FILE"),
    expectedInn: env.GETOMERCH_MARKING_CRPT_INN?.trim() ?? "",
    tokenProbeCommand: absolute(
      env.GETOMERCH_MARKING_AGENT_TOKEN_PROBE_COMMAND
        ?? env.GETOMERCH_MARKING_AGENT_CSPTEST_COMMAND
        ?? "/opt/cprocsp/bin/certmgr",
      "GETOMERCH_MARKING_AGENT_TOKEN_PROBE_COMMAND",
    ),
    pollIntervalMs: integer(env.GETOMERCH_MARKING_AGENT_POLL_MS, 2_000, 500, 30_000),
    cardProbeIntervalMs: integer(env.GETOMERCH_MARKING_AGENT_CARD_PROBE_MS, 10_000, 2_000, 120_000),
  };
}

function exec(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, {
      timeout: 5_000,
      maxBuffer: 64_000,
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin:/opt/cprocsp/bin", NODE_ENV: "production" },
    }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve(`${stdout}\n${stderr}`);
    });
  });
}

function safeError(error: unknown) {
  const code = nestedCode(error).replace(/[^A-Za-z0-9_:-]/g, "_").slice(0, 120)
    || "agent_cycle_failed";
  const raw = error instanceof Error ? error.message : "Mac signing agent failed";
  const message = raw
    .replace(/[A-Za-z0-9+/]{48,}={0,2}/g, "[redacted]")
    .replace(/\]d2[^\s]*/g, "[redacted]")
    .slice(0, 500) || "Mac signing agent failed";
  return { code, message };
}

function nestedCode(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (isRecord(current) && typeof current.code === "string") return current.code;
    current = current instanceof Error ? current.cause : undefined;
  }
  return "agent_cycle_failed";
}

function pinStateForError(code: string, current: MarkingAgentTelemetry["pinState"]) {
  if (/blocked/i.test(code)) return "blocked";
  if (/pin|password|carrier/i.test(code)) return "required";
  return current;
}

function retryableSignerError(code: string) {
  return [
    "signer_timeout",
    "signer_unavailable",
    "provider_pin_unavailable",
    "provider_unavailable",
    "provider_exit_error",
    "provider_timeout",
  ].includes(code);
}

function codedError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function required(value: string | undefined, name: string) {
  const normalized = value?.trim();
  if (!normalized) throw codedError("agent_config_invalid", `${name} is required`);
  return normalized;
}

function absolute(value: string | undefined, name: string) {
  const normalized = required(value, name);
  if (!normalized.startsWith("/") || /[\r\n\0]/.test(normalized)) {
    throw codedError("agent_config_invalid", `${name} must be an absolute path`);
  }
  return normalized;
}

function identifier(value: string, name: string) {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(value)) {
    throw codedError("agent_config_invalid", `${name} is invalid`);
  }
  return value;
}

function text(value: string, name: string, max: number) {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\r\n\0]/.test(normalized)) {
    throw codedError("agent_config_invalid", `${name} is invalid`);
  }
  return normalized;
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = value == null || value.trim() === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw codedError("agent_config_invalid", "Agent interval is invalid");
  }
  return parsed;
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

main().catch((error) => {
  console.error("[marking-mac-agent] fatal", safeError(error));
  process.exitCode = 1;
});
