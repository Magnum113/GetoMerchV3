import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import type { EncryptedMarkingImportRow } from "@/lib/marking/domain/code-pool";

export type MarkingCodeStateSnapshot = {
  id: string;
  poolState: string;
  revision: number;
  fingerprint: string;
  gtin: string;
  blockedReason: string | null;
  updatedAt: string;
};

export async function createCodeImportPreview(
  query: DatabaseQueryExecutor,
  input: {
    source: string;
    filename: string | null;
    contentType: string | null;
    fileSha256: string;
    fileSizeBytes: number;
    expectedGtin: string;
    acquisitionMode: "own_suz_emission" | "remarking";
    rows: EncryptedMarkingImportRow[];
    actorId: string;
  },
) {
  const result = await query<{ batch_id: string }>(
    `
      SELECT getomerch_marking.create_code_import_preview(
        $1, $2, $3, $4, $5::bigint, $6, $7, $8::jsonb, $9
      ) AS batch_id
    `,
    [
      input.source,
      input.filename,
      input.contentType,
      input.fileSha256,
      input.fileSizeBytes,
      input.expectedGtin,
      input.acquisitionMode,
      JSON.stringify(input.rows),
      input.actorId,
    ],
  );
  return result.rows[0].batch_id;
}

export async function applyCodeImport(
  query: DatabaseQueryExecutor,
  batchId: string,
  actorId: string,
) {
  const result = await query<{ summary: Record<string, unknown> }>(
    `
      SELECT getomerch_marking.apply_code_import($1::uuid, $2) AS summary
    `,
    [batchId, actorId],
  );
  return result.rows[0].summary;
}

export async function scrubExpiredCodeImports(
  query: DatabaseQueryExecutor,
  limit = 100,
) {
  const result = await query<{ count: number }>(
    `
      SELECT getomerch_marking.scrub_expired_code_imports($1::integer) AS count
    `,
    [limit],
  );
  return Number(result.rows[0].count);
}

export async function getCodeState(
  query: DatabaseQueryExecutor,
  codeId: string,
): Promise<MarkingCodeStateSnapshot | null> {
  const row = (
    await query<{
      id: string;
      pool_state: string;
      revision: string;
      fingerprint: string;
      gtin_snapshot: string;
      blocked_reason: string | null;
      updated_at: Date | string;
    }>(
      `
        SELECT
          id,
          pool_state,
          revision,
          fingerprint,
          gtin_snapshot,
          blocked_reason,
          updated_at
        FROM getomerch_marking.code_pool_safe
        WHERE id = $1::uuid
      `,
      [codeId],
    )
  ).rows[0];
  return row ? {
    id: row.id,
    poolState: row.pool_state,
    revision: Number(row.revision),
    fingerprint: row.fingerprint,
    gtin: row.gtin_snapshot,
    blockedReason: row.blocked_reason,
    updatedAt: toIso(row.updated_at),
  } : null;
}

export async function quarantineCode(
  query: DatabaseQueryExecutor,
  input: {
    codeId: string;
    expectedRevision: number;
    reason: string;
    actorId: string;
  },
) {
  const row = (
    await query<{
      code_id: string;
      pool_state: string;
      revision: string;
      updated_at: Date | string;
    }>(
      `
        SELECT code_id, pool_state, revision, updated_at
        FROM getomerch_marking.quarantine_code($1::uuid, $2::bigint, $3, $4)
      `,
      [input.codeId, input.expectedRevision, input.reason, input.actorId],
    )
  ).rows[0];
  return {
    codeId: row.code_id,
    poolState: row.pool_state,
    revision: Number(row.revision),
    updatedAt: toIso(row.updated_at),
  };
}

export async function releaseQuarantinedCode(
  query: DatabaseQueryExecutor,
  input: {
    codeId: string;
    expectedRevision: number;
    reason: string;
    destroyedPrintedCopies: boolean;
    actorId: string;
  },
) {
  const row = (
    await query<{
      code_id: string;
      pool_state: string;
      revision: string;
      updated_at: Date | string;
    }>(
      `
        SELECT code_id, pool_state, revision, updated_at
        FROM getomerch_marking.release_quarantined_code(
          $1::uuid, $2::bigint, $3, $4::boolean, $5
        )
      `,
      [
        input.codeId,
        input.expectedRevision,
        input.reason,
        input.destroyedPrintedCopies,
        input.actorId,
      ],
    )
  ).rows[0];
  return {
    codeId: row.code_id,
    poolState: row.pool_state,
    revision: Number(row.revision),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
