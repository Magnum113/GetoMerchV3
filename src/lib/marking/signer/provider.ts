import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SignerCertificateInfo, SignerPurpose } from "@/lib/marking/signer/protocol";

export type MarkingSignatureProvider = {
  certificate: SignerCertificateInfo;
  sign(input: Uint8Array, purpose: SignerPurpose): Promise<Buffer>;
  dispose?(): void;
};

export class MarkingSignatureProviderError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MarkingSignatureProviderError";
  }
}

export async function createCommandSignatureProvider(input: {
  command: string;
  argsJson?: string;
  certificateFile: string;
  expectedInn?: string;
  runtimeDirectory: string;
  sessionPin: Uint8Array;
}): Promise<MarkingSignatureProvider> {
  await assertExecutable(input.command);
  const certificate = await loadCertificateInfo(input.certificateFile, input.expectedInn);
  const args = parseProviderArgs(input.argsJson);
  if (input.sessionPin.length < 1 || input.sessionPin.length > 128) {
    throw new MarkingSignatureProviderError("provider_pin_invalid", "Signer session PIN is invalid");
  }
  const sessionPin = Buffer.from(input.sessionPin);
  let disposed = false;
  return {
    certificate,
    async sign(payload, purpose) {
      if (disposed) {
        throw new MarkingSignatureProviderError(
          "provider_pin_unavailable",
          "Signer session is locked; restart it and enter the PIN again",
        );
      }
      try {
        return await executeProvider({
          command: input.command,
          args,
          certificate,
          payload,
          purpose,
          runtimeDirectory: input.runtimeDirectory,
          sessionPin,
        });
      } catch (error) {
        if (error instanceof MarkingSignatureProviderError
            && error.code === "provider_pin_unavailable") {
          disposed = true;
          sessionPin.fill(0);
        }
        throw error;
      }
    },
    dispose() {
      disposed = true;
      sessionPin.fill(0);
    },
  };
}

export async function loadCertificateInfo(path: string, expectedInn?: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new MarkingSignatureProviderError(
      "certificate_metadata_unavailable",
      "Signer certificate metadata cannot be read",
      { cause: error },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MarkingSignatureProviderError("certificate_metadata_invalid", "Signer certificate metadata is invalid");
  }
  const value = parsed as Record<string, unknown>;
  const certificate: SignerCertificateInfo = {
    thumbprint: String(value.thumbprint ?? "").replace(/\s+/g, "").toUpperCase(),
    subject: String(value.subject ?? "").trim(),
    inn: String(value.inn ?? "").trim(),
    ogrn: value.ogrn == null ? null : String(value.ogrn).trim(),
    validFrom: normalizedDate(value.validFrom),
    validTo: normalizedDate(value.validTo),
    algorithm: String(value.algorithm ?? "").trim(),
  };
  if (!/^[0-9A-F]{40,128}$/.test(certificate.thumbprint)) {
    throw new MarkingSignatureProviderError("certificate_thumbprint_invalid", "Signer certificate thumbprint is invalid");
  }
  if (!certificate.subject || certificate.subject.length > 500) {
    throw new MarkingSignatureProviderError("certificate_subject_invalid", "Signer certificate subject is invalid");
  }
  if (!/^\d{10}(?:\d{2})?$/.test(certificate.inn)) {
    throw new MarkingSignatureProviderError("certificate_inn_invalid", "Signer certificate INN is invalid");
  }
  if (expectedInn && certificate.inn !== expectedInn) {
    throw new MarkingSignatureProviderError("certificate_inn_mismatch", "Signer certificate INN does not match configuration");
  }
  if (certificate.ogrn && !/^\d{13}(?:\d{2})?$/.test(certificate.ogrn)) {
    throw new MarkingSignatureProviderError("certificate_ogrn_invalid", "Signer certificate OGRN is invalid");
  }
  if (!/GOST|ГОСТ|34\.10-2012/i.test(certificate.algorithm)) {
    throw new MarkingSignatureProviderError("certificate_algorithm_invalid", "Signer certificate algorithm is not GOST 2012");
  }
  const now = Date.now();
  if (Date.parse(certificate.validFrom) > now) {
    throw new MarkingSignatureProviderError("certificate_not_yet_valid", "Signer certificate is not valid yet");
  }
  if (Date.parse(certificate.validTo) <= now) {
    throw new MarkingSignatureProviderError("certificate_expired", "Signer certificate has expired");
  }
  return Object.freeze(certificate);
}

function parseProviderArgs(source: string | undefined) {
  if (!source?.trim()) {
    return [
      "-sign", "-cadesbes", "-der", "-strict", "-cert", "-thumbprint",
      "{thumbprint}", "-askpin", "{input}", "{output}",
    ];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new MarkingSignatureProviderError("provider_args_invalid", "Signer provider arguments are invalid JSON", { cause: error });
  }
  if (
    !Array.isArray(parsed)
    || parsed.length < 1
    || parsed.length > 40
    || parsed.some((value) => typeof value !== "string" || value.length > 500 || /[\r\n\0]/.test(value))
  ) {
    throw new MarkingSignatureProviderError("provider_args_invalid", "Signer provider arguments are invalid");
  }
  if (!parsed.includes("{input}") || !parsed.includes("{output}")) {
    throw new MarkingSignatureProviderError("provider_args_invalid", "Signer provider arguments require input and output placeholders");
  }
  if (!parsed.includes("-askpin") || parsed.includes("-pin")) {
    throw new MarkingSignatureProviderError(
      "provider_args_invalid",
      "Signer provider arguments must read PIN from stdin with -askpin",
    );
  }
  return parsed;
}

async function executeProvider(input: {
  command: string;
  args: string[];
  certificate: SignerCertificateInfo;
  payload: Uint8Array;
  purpose: SignerPurpose;
  runtimeDirectory: string;
  sessionPin: Uint8Array;
}) {
  if (input.purpose !== "crpt_auth_attached_cades_bes"
      && input.purpose !== "crpt_document_detached_cades_bes"
      && input.purpose !== "crpt_suz_order_detached_cades_bes") {
    throw new MarkingSignatureProviderError("provider_purpose_denied", "Signature purpose is not supported");
  }
  await assertCryptoProLicense(input.command);
  const directory = await mkdtemp(join(input.runtimeDirectory, "sign-"));
  await chmod(directory, 0o700);
  const inputPath = join(directory, "payload.bin");
  const outputPath = join(directory, "signature.der");
  try {
    await writeFile(inputPath, Buffer.from(input.payload), { mode: 0o600, flag: "wx" });
    const purposeArgs = providerArgsForPurpose(input.args, input.purpose);
    const args = purposeArgs.map((value) => value
      .replaceAll("{thumbprint}", input.certificate.thumbprint)
      .replaceAll("{input}", inputPath)
      .replaceAll("{output}", outputPath));
    console.log("[marking-signer] CryptoPro signing started with the unlocked local session");
    const result = await runProvider(input.command, args, input.sessionPin);
    if (result.code !== 0) {
      const error = providerErrorFromStderr(result.stderr);
      console.error("[marking-signer] CryptoPro signing failed", {
        code: error.code,
        message: error.message,
      });
      throw error;
    }
    const signature = await readFile(outputPath);
    if (signature.length < 64 || signature.length > 131_072) {
      signature.fill(0);
      throw new MarkingSignatureProviderError("provider_output_invalid", "Signature provider returned an invalid output size");
    }
    return signature;
  } catch (error) {
    if (error instanceof MarkingSignatureProviderError) throw error;
    throw new MarkingSignatureProviderError("provider_failed", "Signature provider failed", { cause: error });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertCryptoProLicense(command: string) {
  if (!/\/cryptcp$/.test(command)) return;
  const cpconfig = join(dirname(dirname(command)), "sbin", "cpconfig");
  await assertExecutable(cpconfig);
  const result = await runDiagnosticCommand(cpconfig, ["-license", "-view"]);
  if (result.code !== 0) throw providerErrorFromStderr(result.output);
}

function runDiagnosticCommand(command: string, args: string[]) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin:/opt/cprocsp/bin", NODE_ENV: "production" },
    });
    let output = "";
    let settled = false;
    const finish = (error?: unknown, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code, output });
    };
    const append = (chunk: string) => { output = `${output}${chunk}`.slice(-16_384); };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(undefined, code));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new MarkingSignatureProviderError("provider_timeout", "CryptoPro license check timed out"));
    }, 5_000);
  });
}

function providerArgsForPurpose(args: string[], purpose: SignerPurpose) {
  const detachedIndex = args.indexOf("-detached");
  if (purpose === "crpt_auth_attached_cades_bes") {
    if (detachedIndex >= 0) {
      throw new MarkingSignatureProviderError(
        "provider_args_invalid",
        "Attached CRPT authentication cannot use detached signing arguments",
      );
    }
    return args;
  }
  if (detachedIndex >= 0) return args;
  const signIndex = args.indexOf("-sign");
  const output = [...args];
  output.splice(signIndex >= 0 ? signIndex + 1 : 0, 0, "-detached");
  return output;
}

export function runProvider(command: string, args: string[], sessionPin: Uint8Array) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "ignore", "pipe"],
      env: {
        PATH: "/usr/bin:/bin:/opt/cprocsp/bin/arm64:/opt/cprocsp/bin/amd64",
        NODE_ENV: "production",
      },
    });
    let stderr = "";
    let settled = false;
    const finish = (error?: unknown, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code, stderr });
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_192);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(undefined, code));
    child.stdin.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") finish(error);
    });
    child.stdin.write(sessionPin);
    child.stdin.end(Buffer.from([0x0a]));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new MarkingSignatureProviderError("provider_timeout", "Signature provider timed out"));
    }, 60_000);
  });
}

export function providerErrorFromStderr(stderr: string) {
  if (/license[^\n]{0,80}(expired|not yet valid)|лиценз[^\n]{0,80}(ист[её]к|недейств)|0x20000325/i.test(stderr)) {
    return new MarkingSignatureProviderError(
      "provider_license_expired",
      "CryptoPro CSP license is expired or not valid yet",
    );
  }
  if (/pin|password|парол|носител|token/i.test(stderr)) {
    return new MarkingSignatureProviderError("provider_pin_unavailable", "Signature key carrier or PIN is unavailable");
  }
  if (/certificate|сертификат|expired|ист[её]к/i.test(stderr)) {
    return new MarkingSignatureProviderError("provider_certificate_error", "Signature certificate is unavailable");
  }
  const diagnosticCode = extractCryptoProErrorCode(stderr);
  return new MarkingSignatureProviderError(
    "provider_exit_error",
    diagnosticCode
      ? `Signature provider returned an error (${diagnosticCode})`
      : "Signature provider returned an error",
  );
}

function extractCryptoProErrorCode(stderr: string) {
  const matches = [...stderr.matchAll(/(?:ErrorCode\s*:\s*|\b)(0x[0-9a-f]{8})\b/gi)];
  return matches.at(-1)?.[1]?.toLowerCase() ?? null;
}

async function assertExecutable(path: string) {
  try {
    const info = await stat(path);
    if (!info.isFile() || (info.mode & 0o022) !== 0) {
      throw new Error("provider executable is not a protected regular file");
    }
    await access(path, constants.X_OK);
  } catch (error) {
    throw new MarkingSignatureProviderError("provider_unavailable", "Signature provider executable is unavailable or unsafe", { cause: error });
  }
}

function normalizedDate(value: unknown) {
  const date = new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime())) {
    throw new MarkingSignatureProviderError("certificate_date_invalid", "Signer certificate date is invalid");
  }
  return date.toISOString();
}
