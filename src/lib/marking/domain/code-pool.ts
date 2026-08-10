import "server-only";

import { createHash } from "node:crypto";
import { MarkingDomainError } from "@/lib/marking/domain/errors";
import { normalizeGtin14 } from "@/lib/marking/domain/invariants";
import type { MarkingKeyring } from "@/lib/marking/security/keyring";

export const MARKING_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const MARKING_IMPORT_MAX_ROWS = 5_000;
export const MARKING_CODE_MIN_BYTES = 24;
export const MARKING_CODE_MAX_BYTES = 512;

export type MarkingCodeImportRowStatus =
  | "valid"
  | "duplicate_file"
  | "gtin_mismatch"
  | "rejected";

export type EncryptedMarkingImportRow = {
  rowNumber: number;
  status: MarkingCodeImportRowStatus;
  gtin: string | null;
  serial: string | null;
  fingerprint: string | null;
  errorCodes: string[];
  encryptionKeyVersion?: number;
  hmacKeyVersion?: number;
  primaryHmac?: string;
  hmacs?: Array<{ keyVersion: number; digest: string }>;
  ciphertext?: string;
  nonce?: string;
  authTag?: string;
};

export type MarkingCodeImportPayload = {
  fileSha256: string;
  fileSizeBytes: number;
  sourceLineCount: number;
  rows: EncryptedMarkingImportRow[];
};

export async function parseAndEncryptMarkingCodeStream(input: {
  body: ReadableStream<Uint8Array> | null;
  expectedGtin: string;
  keyring: MarkingKeyring;
}): Promise<MarkingCodeImportPayload> {
  const expectedGtin = normalizeGtin14(input.expectedGtin);
  if (!input.body) {
    throw new MarkingDomainError("invalid_code_import", "Import file is empty");
  }

  const reader = input.body.getReader();
  const fileHash = createHash("sha256");
  const seen = new Set<string>();
  const rows: EncryptedMarkingImportRow[] = [];
  let fileSizeBytes = 0;
  let sourceLineCount = 0;
  let firstLine = true;
  let lineChunks: Buffer[] = [];
  let lineLength = 0;

  const clearLine = () => {
    for (const chunk of lineChunks) chunk.fill(0);
    lineChunks = [];
    lineLength = 0;
  };

  const append = (bytes: Uint8Array) => {
    if (bytes.byteLength === 0) return;
    lineLength += bytes.byteLength;
    if (lineLength > MARKING_CODE_MAX_BYTES + 3) {
      throw new MarkingDomainError(
        "invalid_code_import",
        `Import row ${sourceLineCount + 1} is too large`,
      );
    }
    lineChunks.push(Buffer.from(bytes));
  };

  const finishLine = () => {
    sourceLineCount += 1;
    let line = Buffer.concat(lineChunks, lineLength);
    clearLine();
    try {
      if (line.length > 0 && line[line.length - 1] === 0x0d) {
        const withoutCr = Buffer.from(line.subarray(0, line.length - 1));
        line.fill(0);
        line = withoutCr;
      }
      if (firstLine && line.length >= 3 && line.subarray(0, 3).equals(BOM)) {
        const withoutBom = Buffer.from(line.subarray(3));
        line.fill(0);
        line = withoutBom;
      }
      firstLine = false;
      if (line.length === 0) return;
      if (rows.length >= MARKING_IMPORT_MAX_ROWS) {
        throw new MarkingDomainError(
          "invalid_code_import",
          `Import file exceeds ${MARKING_IMPORT_MAX_ROWS} non-empty rows`,
        );
      }

      const code = unwrapSingleCsvCell(line);
      try {
        rows.push(parseAndEncryptCode(code, sourceLineCount, expectedGtin, input.keyring, seen));
      } finally {
        code.fill(0);
      }
    } finally {
      line.fill(0);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      fileSizeBytes += value.byteLength;
      if (fileSizeBytes > MARKING_IMPORT_MAX_BYTES) {
        throw new MarkingDomainError(
          "invalid_code_import",
          `Import file exceeds ${MARKING_IMPORT_MAX_BYTES} bytes`,
        );
      }
      fileHash.update(value);

      let start = 0;
      for (let index = 0; index < value.byteLength; index += 1) {
        if (value[index] !== 0x0a) continue;
        append(value.subarray(start, index));
        finishLine();
        start = index + 1;
      }
      append(value.subarray(start));
    }
    if (lineLength > 0) finishLine();
  } finally {
    clearLine();
    reader.releaseLock();
  }

  if (fileSizeBytes === 0 || rows.length === 0) {
    throw new MarkingDomainError(
      "invalid_code_import",
      "Import file has no marking codes",
    );
  }
  return {
    fileSha256: fileHash.digest("hex"),
    fileSizeBytes,
    sourceLineCount,
    rows,
  };
}

export function parseAndEncryptMarkingCodes(input: {
  codes: readonly string[];
  expectedGtin: string;
  keyring: MarkingKeyring;
}): MarkingCodeImportPayload {
  const expectedGtin = normalizeGtin14(input.expectedGtin);
  if (input.codes.length < 1 || input.codes.length > MARKING_IMPORT_MAX_ROWS) {
    throw new MarkingDomainError(
      "invalid_code_import",
      `SUZ response must contain between 1 and ${MARKING_IMPORT_MAX_ROWS} codes`,
    );
  }
  const fileHash = createHash("sha256");
  const seen = new Set<string>();
  const rows: EncryptedMarkingImportRow[] = [];
  let fileSizeBytes = 0;
  for (let index = 0; index < input.codes.length; index += 1) {
    const value = input.codes[index];
    if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
      throw new MarkingDomainError(
        "invalid_code_import",
        `SUZ code ${index + 1} has an invalid transport format`,
      );
    }
    const code = Buffer.from(value, "utf8");
    try {
      if (code.length > MARKING_CODE_MAX_BYTES) {
        throw new MarkingDomainError(
          "invalid_code_import",
          `SUZ code ${index + 1} is too large`,
        );
      }
      fileHash.update(code);
      fileSizeBytes += code.length;
      if (index < input.codes.length - 1) {
        fileHash.update("\n", "ascii");
        fileSizeBytes += 1;
      }
      if (fileSizeBytes > MARKING_IMPORT_MAX_BYTES) {
        throw new MarkingDomainError(
          "invalid_code_import",
          `SUZ response exceeds ${MARKING_IMPORT_MAX_BYTES} bytes`,
        );
      }
      rows.push(parseAndEncryptCode(
        code,
        index + 1,
        expectedGtin,
        input.keyring,
        seen,
      ));
    } finally {
      code.fill(0);
    }
  }
  return {
    fileSha256: fileHash.digest("hex"),
    fileSizeBytes,
    sourceLineCount: input.codes.length,
    rows,
  };
}

export function assertPoolStateChange(input: {
  codeId: string;
  expectedRevision: number;
  reason: string;
  destroyedPrintedCopies?: boolean;
  release?: boolean;
}) {
  if (!isUuid(input.codeId)) {
    throw new MarkingDomainError("invalid_code_state", "codeId must be a UUID");
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new MarkingDomainError(
      "invalid_code_state",
      "expectedRevision must be a positive integer",
    );
  }
  const reason = input.reason.trim();
  if (reason.length < 1 || reason.length > 1_000) {
    throw new MarkingDomainError(
      "invalid_code_state",
      "reason must contain between 1 and 1000 characters",
    );
  }
  if (input.release && input.destroyedPrintedCopies !== true) {
    throw new MarkingDomainError(
      "invalid_code_state",
      "Printed copies destruction must be confirmed",
    );
  }
}

function parseAndEncryptCode(
  code: Buffer,
  rowNumber: number,
  expectedGtin: string,
  keyring: MarkingKeyring,
  seen: Set<string>,
): EncryptedMarkingImportRow {
  const parsed = parseGs1MarkingCode(code);
  const fingerprints = keyring.fingerprintsBytes(code);
  const primary = fingerprints[0];
  if (!primary) {
    throw new MarkingDomainError(
      "invalid_code_import",
      "No HMAC key is available for import",
    );
  }
  const fingerprint = primary?.digest.slice(0, 12) ?? null;
  if (!parsed.ok) {
    return {
      rowNumber,
      status: "rejected",
      gtin: parsed.gtin,
      serial: parsed.serial,
      fingerprint,
      errorCodes: parsed.errors,
    };
  }
  if (parsed.gtin !== expectedGtin) {
    return {
      rowNumber,
      status: "gtin_mismatch",
      gtin: parsed.gtin,
      serial: parsed.serial,
      fingerprint,
      errorCodes: ["gtin_mismatch"],
    };
  }
  const duplicateKey = `${primary.keyVersion}:${primary.digest}`;
  if (seen.has(duplicateKey)) {
    return {
      rowNumber,
      status: "duplicate_file",
      gtin: parsed.gtin,
      serial: parsed.serial,
      fingerprint,
      errorCodes: ["duplicate_file"],
    };
  }
  seen.add(duplicateKey);
  const encrypted = keyring.encryptBytes(code);
  return {
    rowNumber,
    status: "valid",
    gtin: parsed.gtin,
    serial: parsed.serial,
    fingerprint,
    errorCodes: [],
    encryptionKeyVersion: encrypted.keyVersion,
    hmacKeyVersion: primary.keyVersion,
    primaryHmac: primary.digest,
    hmacs: fingerprints.map((item) => ({
      keyVersion: item.keyVersion,
      digest: item.digest,
    })),
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.iv,
    authTag: encrypted.authTag,
  };
}

export function parseGs1MarkingCode(code: Buffer):
  | { ok: true; gtin: string; serial: string }
  | { ok: false; gtin: string | null; serial: string | null; errors: string[] } {
  const errors: string[] = [];
  if (code.length < MARKING_CODE_MIN_BYTES) errors.push("code_too_short");
  if (code.length > MARKING_CODE_MAX_BYTES) errors.push("code_too_long");
  if ([...code].some((value) => value !== GROUP_SEPARATOR && (value < 0x20 || value > 0x7e))) {
    errors.push("unsupported_character");
  }

  const offset = startsWith(code, SYMBOLOGY_PREFIX, 0) ? SYMBOLOGY_PREFIX.length : 0;
  if (!startsWith(code, AI_01, offset)) errors.push("missing_ai_01");
  const rawGtin = code.subarray(offset + 2, offset + 16);
  const gtinText = rawGtin.length === 14 && [...rawGtin].every(isDigit)
    ? rawGtin.toString("ascii")
    : null;
  let gtin: string | null = null;
  if (gtinText) {
    try {
      gtin = normalizeGtin14(gtinText);
    } catch {
      errors.push("invalid_gtin");
    }
  } else {
    errors.push("invalid_gtin");
  }

  const serialAiOffset = offset + 16;
  if (!startsWith(code, AI_21, serialAiOffset)) errors.push("missing_ai_21");
  const serialStart = serialAiOffset + 2;
  const firstSeparator = code.indexOf(GROUP_SEPARATOR, serialStart);
  let serial: string | null = null;
  if (
    firstSeparator < 0
    || firstSeparator - serialStart < 1
    || firstSeparator - serialStart > 20
  ) {
    errors.push("invalid_serial");
  } else {
    const serialBytes = code.subarray(serialStart, firstSeparator);
    if ([...serialBytes].every((value) => value >= 0x21 && value <= 0x7e)) {
      serial = serialBytes.toString("ascii");
    } else {
      errors.push("invalid_serial");
    }
  }

  const ai91Offset = firstSeparator + 1;
  if (firstSeparator < 0 || !startsWith(code, AI_91, ai91Offset)) {
    errors.push("missing_ai_91");
  }
  const secondSeparator = firstSeparator < 0
    ? -1
    : code.indexOf(GROUP_SEPARATOR, ai91Offset + 2);
  if (
    secondSeparator < 0
    || !startsWith(code, AI_92, secondSeparator + 1)
    || code.length <= secondSeparator + 3
  ) {
    errors.push("missing_ai_92");
  }

  if (errors.length > 0 || !gtin || !serial) {
    return { ok: false, gtin, serial, errors: [...new Set(errors)] };
  }
  return { ok: true, gtin, serial };
}

function unwrapSingleCsvCell(line: Buffer) {
  if (line.length < 2 || line[0] !== QUOTE || line[line.length - 1] !== QUOTE) {
    return Buffer.from(line);
  }
  const output = Buffer.allocUnsafe(line.length - 2);
  let write = 0;
  for (let read = 1; read < line.length - 1; read += 1) {
    if (line[read] === QUOTE && line[read + 1] === QUOTE) read += 1;
    output[write] = line[read];
    write += 1;
  }
  const exact = Buffer.from(output.subarray(0, write));
  output.fill(0);
  return exact;
}

function startsWith(source: Buffer, expected: Buffer, offset: number) {
  return offset >= 0
    && source.length >= offset + expected.length
    && source.subarray(offset, offset + expected.length).equals(expected);
}

function isDigit(value: number) {
  return value >= 0x30 && value <= 0x39;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const SYMBOLOGY_PREFIX = Buffer.from("]d2", "ascii");
const AI_01 = Buffer.from("01", "ascii");
const AI_21 = Buffer.from("21", "ascii");
const AI_91 = Buffer.from("91", "ascii");
const AI_92 = Buffer.from("92", "ascii");
const GROUP_SEPARATOR = 0x1d;
const QUOTE = 0x22;
