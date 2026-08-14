import "server-only";

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 12;
const SENSITIVE_KEYS = new Set([
  "apikey",
  "authorization",
  "clienttoken",
  "cis",
  "code",
  "codes",
  "cryptotail",
  "datamatrix",
  "datamatrixpayload",
  "databaseurl",
  "gs1",
  "gs1payload",
  "ki",
  "mandatorymark",
  "mark",
  "markingcode",
  "pdf",
  "pdfparameters",
  "privatekey",
  "productdocument",
  "signature",
  "signedbody",
  "token",
  "uitcode",
]);

const RAW_GS1_PATTERN = /(?:\(01\)|01)\d{14}(?:\(21\)|21)[^\s]{1,40}(?:\u001d|\(91\)|91)[^\s]{1,12}(?:\u001d|\(92\)|92)[^\s]{8,}/gi;
const BRACKETED_GS1_PATTERN = /\(01\)\d{14}\(21\)[^\s]{1,40}(?:\(91\)[^\s]{1,12})?(?:\(92\)[^\s]{8,})?/gi;
const GS1_IDENTIFICATION_PATTERN = /(?:\(01\)|01)\d{14}(?:\(21\)|21)[^\s,;]{1,40}/gi;

export function redactSensitiveData(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet<object>());
}

export function redactText(value: string) {
  return value
    .replace(RAW_GS1_PATTERN, REDACTED)
    .replace(BRACKETED_GS1_PATTERN, REDACTED)
    .replace(GS1_IDENTIFICATION_PATTERN, REDACTED)
    .replace(/[\u001d\u001e\u0000]/g, "");
}

export function containsSensitiveMarkingData(value: unknown): boolean {
  return findSensitiveValue(value, 0, new WeakSet<object>());
}

export function safeErrorForLog(error: unknown) {
  if (error instanceof Error) {
    const source = error as Error & { code?: unknown };
    return {
      name: redactText(error.name),
      message: redactText(error.message),
      code: typeof source.code === "string" ? redactText(source.code) : undefined,
    };
  }
  const redacted = redactSensitiveData(error);
  if (redacted && typeof redacted === "object") return redacted;
  return { message: redactText(String(redacted)) };
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return "[MAX_DEPTH]";
  if (typeof value === "string") return redactText(value);
  if (
    value === null
    || typeof value === "number"
    || typeof value === "boolean"
    || typeof value === "undefined"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return safeErrorForLog(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return "[BINARY_REDACTED]";
  if (typeof value !== "object") return redactText(String(value));
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1, seen));

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key)
      ? REDACTED
      : redactValue(item, depth + 1, seen);
  }
  return output;
}

function findSensitiveValue(value: unknown, depth: number, seen: WeakSet<object>): boolean {
  if (depth > MAX_DEPTH) return false;
  if (typeof value === "string") {
    RAW_GS1_PATTERN.lastIndex = 0;
    BRACKETED_GS1_PATTERN.lastIndex = 0;
    GS1_IDENTIFICATION_PATTERN.lastIndex = 0;
    return RAW_GS1_PATTERN.test(value)
      || BRACKETED_GS1_PATTERN.test(value)
      || GS1_IDENTIFICATION_PATTERN.test(value);
  }
  if (!value || typeof value !== "object") return false;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => findSensitiveValue(item, depth + 1, seen));
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([key, item]) => isSensitiveKey(key) || findSensitiveValue(item, depth + 1, seen),
  );
}

function isSensitiveKey(key: string) {
  return SENSITIVE_KEYS.has(key.replace(/[^A-Za-z0-9]/g, "").toLowerCase());
}
