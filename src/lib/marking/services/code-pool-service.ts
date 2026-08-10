import "server-only";

import path from "node:path";
import type { ServerMutationContext } from "@/lib/db/mutations/runner";
import { runServerMutation } from "@/lib/db/mutations/runner";
import {
  getMarkingRuntimeConfig,
  type MarkingRuntimeConfig,
} from "@/lib/marking/config";
import {
  assertPoolStateChange,
  parseAndEncryptMarkingCodeStream,
} from "@/lib/marking/domain/code-pool";
import { MarkingDomainError } from "@/lib/marking/domain/errors";
import { normalizeGtin14 } from "@/lib/marking/domain/invariants";
import {
  applyCodeImport,
  createCodeImportPreview,
  getCodeState,
  quarantineCode,
  releaseQuarantinedCode,
  scrubExpiredCodeImports,
} from "@/lib/marking/repositories/code-pool";
import {
  loadMarkingKeyring,
  type MarkingKeyring,
} from "@/lib/marking/security/keyring";

type CodePoolDependencies = {
  config?: MarkingRuntimeConfig;
  keyring?: MarkingKeyring;
};

export async function previewMarkingCodeImport(
  input: {
    body: ReadableStream<Uint8Array> | null;
    expectedGtin: string;
    filename?: string | null;
    contentType?: string | null;
    acquisitionMode: "own_suz_emission" | "remarking";
  },
  context: ServerMutationContext,
  dependencies: CodePoolDependencies = {},
) {
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  const expectedGtin = normalizeGtin14(input.expectedGtin);
  assertImportAccess(config, context.actor, expectedGtin);
  const filename = normalizeFilename(input.filename);
  const contentType = normalizeContentType(input.contentType);
  if (!["own_suz_emission", "remarking"].includes(input.acquisitionMode)) {
    throw new MarkingDomainError(
      "invalid_code_import",
      "Unsupported acquisition mode",
    );
  }
  const keyring = dependencies.keyring ?? await loadMarkingKeyring(config.keyringFile);
  const parsed = await parseAndEncryptMarkingCodeStream({
    body: input.body,
    expectedGtin,
    keyring,
  });

  return runServerMutation({
    operation: "marking.code-import.preview",
    payload: {
      expectedGtin,
      filename,
      contentType,
      acquisitionMode: input.acquisitionMode,
      fileSha256: parsed.fileSha256,
      fileSizeBytes: parsed.fileSizeBytes,
      sourceLineCount: parsed.sourceLineCount,
    },
    context,
    execute: async (query, checkpoint) => {
      await scrubExpiredCodeImports(query, 100);
      checkpoint("expired_imports_scrubbed");
      const batchId = await createCodeImportPreview(query, {
        source: "admin_manual_import",
        filename,
        contentType,
        fileSha256: parsed.fileSha256,
        fileSizeBytes: parsed.fileSizeBytes,
        expectedGtin,
        acquisitionMode: input.acquisitionMode,
        rows: parsed.rows,
        actorId: context.actor,
      });
      checkpoint("code_import_preview_created");
      return {
        data: {
          batchId,
          fileSha256: parsed.fileSha256,
          fileSizeBytes: parsed.fileSizeBytes,
          sourceLineCount: parsed.sourceLineCount,
        },
        audit: {
          entityType: "marking_code_import",
          entityId: batchId,
          after: {
            batchId,
            expectedGtin,
            fileSha256: parsed.fileSha256,
            fileSizeBytes: parsed.fileSizeBytes,
            rowCount: parsed.rows.length,
          },
        },
      };
    },
  });
}

export async function applyMarkingCodeImport(
  input: { batchId: string },
  context: ServerMutationContext,
  dependencies: Pick<CodePoolDependencies, "config"> = {},
) {
  assertUuid(input.batchId, "batchId");
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  assertImportAccess(config, context.actor);
  return runServerMutation({
    operation: "marking.code-import.apply",
    payload: input,
    context,
    execute: async (query, checkpoint) => {
      const summary = await applyCodeImport(query, input.batchId, context.actor);
      checkpoint("code_import_applied");
      return {
        data: { batchId: input.batchId, summary },
        audit: {
          entityType: "marking_code_import",
          entityId: input.batchId,
          after: { batchId: input.batchId, summary },
        },
      };
    },
  });
}

export async function quarantineMarkingCode(
  input: { codeId: string; expectedRevision: number; reason: string },
  context: ServerMutationContext,
  dependencies: Pick<CodePoolDependencies, "config"> = {},
) {
  assertPoolStateChange(input);
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  assertImportAccess(config, context.actor);
  const reason = input.reason.trim();
  return runServerMutation({
    operation: "marking.code.quarantine",
    payload: { ...input, reason },
    context,
    execute: async (query, checkpoint) => {
      const before = await getCodeState(query, input.codeId);
      if (!before) {
        throw new MarkingDomainError("code_not_found", "Marking code not found");
      }
      const changed = await quarantineCode(query, {
        ...input,
        reason,
        actorId: context.actor,
      });
      checkpoint("marking_code_quarantined");
      return {
        data: changed,
        audit: {
          entityType: "marking_code",
          entityId: input.codeId,
          before,
          after: { ...before, ...changed, blockedReason: reason },
        },
      };
    },
  });
}

export async function releaseMarkingCode(
  input: {
    codeId: string;
    expectedRevision: number;
    reason: string;
    destroyedPrintedCopies: boolean;
  },
  context: ServerMutationContext,
  dependencies: Pick<CodePoolDependencies, "config"> = {},
) {
  assertPoolStateChange({ ...input, release: true });
  const config = dependencies.config ?? getMarkingRuntimeConfig();
  assertImportAccess(config, context.actor);
  const reason = input.reason.trim();
  return runServerMutation({
    operation: "marking.code.release",
    payload: { ...input, reason },
    context,
    execute: async (query, checkpoint) => {
      const before = await getCodeState(query, input.codeId);
      if (!before) {
        throw new MarkingDomainError("code_not_found", "Marking code not found");
      }
      const changed = await releaseQuarantinedCode(query, {
        ...input,
        reason,
        actorId: context.actor,
      });
      checkpoint("marking_code_released");
      return {
        data: changed,
        audit: {
          entityType: "marking_code",
          entityId: input.codeId,
          before,
          after: { ...before, ...changed, blockedReason: null },
        },
      };
    },
  });
}

export function assertImportAccess(
  config: MarkingRuntimeConfig,
  actor: string,
  gtin?: string,
) {
  if (!config.enabled || !config.importEnabled) {
    throw new MarkingDomainError(
      "invalid_code_import",
      "Marking-code import is disabled",
    );
  }
  if (!config.allowedAdminIds.includes(actor)) {
    throw new MarkingDomainError(
      "invalid_code_import",
      "Administrator is not allowed to manage the marking-code pool",
    );
  }
  if (gtin && !config.allowedGtins.includes(gtin)) {
    throw new MarkingDomainError(
      "invalid_code_import",
      "GTIN is outside the marking import allow-list",
    );
  }
}

function normalizeFilename(value: string | null | undefined) {
  if (!value) return null;
  const normalized = path.basename(value).normalize("NFC");
  if (
    normalized.length < 1
    || normalized.length > 255
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new MarkingDomainError("invalid_code_import", "Invalid import filename");
  }
  if (!/\.(txt|csv)$/i.test(normalized)) {
    throw new MarkingDomainError(
      "invalid_code_import",
      "Only TXT or single-column CSV files are supported",
    );
  }
  return normalized;
}

function normalizeContentType(value: string | null | undefined) {
  if (!value) return null;
  const contentType = value.split(";")[0].trim().toLowerCase();
  if (
    !["text/plain", "text/csv", "application/csv", "application/octet-stream"]
      .includes(contentType)
  ) {
    throw new MarkingDomainError(
      "invalid_code_import",
      "Unsupported import content type",
    );
  }
  return contentType;
}

function assertUuid(value: string, name: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value)) {
    throw new MarkingDomainError("invalid_code_import", `${name} must be a UUID`);
  }
}
