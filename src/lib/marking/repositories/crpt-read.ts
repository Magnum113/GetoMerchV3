import "server-only";

import { queryServerDatabase, type DatabaseQueryExecutor } from "@/lib/db/pool";
import type { InternalCrptState } from "@/lib/marking/adapters/crpt/contracts";

export type CrptReadQueryType = "code_status" | "document_status";
export type CrptReadQueryStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "manual_review";

export type CrptReadQuery = {
  id: string;
  queryType: CrptReadQueryType;
  markingCodeId: string | null;
  fingerprint: string | null;
  gtin: string | null;
  externalDocumentId: string | null;
  productGroup: string;
  status: CrptReadQueryStatus;
  normalizedStatus: string | null;
  rawStatus: string | null;
  result: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  ownerMatches: boolean | null;
  gtinMatches: boolean | null;
  requestedBy: string;
  requestId: string;
  attemptCount: number;
  checkedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type CrptReadQueryRow = {
  id: string;
  query_type: CrptReadQueryType;
  marking_code_id: string | null;
  fingerprint: string | null;
  gtin_snapshot: string | null;
  external_document_id: string | null;
  product_group: string;
  status: CrptReadQueryStatus;
  normalized_status: string | null;
  raw_status: string | null;
  result_redacted: Record<string, unknown>;
  error_code: string | null;
  error_message: string | null;
  owner_matches: boolean | null;
  gtin_matches: boolean | null;
  requested_by: string;
  request_id: string;
  attempt_count: number;
  checked_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const SAFE_COLUMNS = `
  id, query_type, marking_code_id, fingerprint, gtin_snapshot,
  external_document_id, product_group, status, normalized_status, raw_status,
  result_redacted, error_code, error_message, owner_matches, gtin_matches,
  requested_by, request_id, attempt_count, checked_at, created_at, updated_at
`;

export async function createCrptReadQuery(
  query: DatabaseQueryExecutor,
  input: {
    queryType: CrptReadQueryType;
    markingCodeId?: string;
    externalDocumentId?: string;
    actorId: string;
    requestId: string;
  },
) {
  const result = await query<{ id: string }>(
    `SELECT getomerch_marking.create_crpt_read_query($1,$2::uuid,$3,$4,$5::uuid) AS id`,
    [
      input.queryType,
      input.markingCodeId ?? null,
      input.externalDocumentId ?? null,
      input.actorId,
      input.requestId,
    ],
  );
  return result.rows[0].id;
}

export async function claimCrptReadQuery(
  query: DatabaseQueryExecutor,
  queryId: string,
  actorId: string,
) {
  const result = await query<{
    query_id: string;
    query_type: CrptReadQueryType;
    marking_code_id: string | null;
    external_document_id: string | null;
    product_group: string;
    gtin_snapshot: string | null;
    fingerprint: string | null;
    code_ciphertext: Buffer | null;
    code_nonce: Buffer | null;
    code_auth_tag: Buffer | null;
    encryption_key_version: number | null;
  }>(
    `SELECT * FROM getomerch_marking.claim_crpt_read_query($1::uuid,$2)`,
    [queryId, actorId],
  );
  return result.rows[0];
}

export async function recordCrptReadSuccess(
  query: DatabaseQueryExecutor,
  input: {
    queryId: string;
    normalizedStatus: InternalCrptState | string;
    rawStatus: string;
    result: Record<string, unknown>;
    ownerMatches: boolean | null;
    gtinMatches: boolean | null;
  },
) {
  const result = await query<{ status: CrptReadQueryStatus }>(
    `
      SELECT getomerch_marking.record_crpt_read_success(
        $1::uuid,$2,$3,$4::jsonb,$5::boolean,$6::boolean
      ) AS status
    `,
    [
      input.queryId,
      input.normalizedStatus,
      input.rawStatus,
      JSON.stringify(input.result),
      input.ownerMatches,
      input.gtinMatches,
    ],
  );
  return result.rows[0].status;
}

export async function recordCrptReadFailure(
  query: DatabaseQueryExecutor,
  input: { queryId: string; errorCode: string; errorMessage: string },
) {
  await query(
    `SELECT getomerch_marking.record_crpt_read_failure($1::uuid,$2,$3)`,
    [input.queryId, input.errorCode, input.errorMessage],
  );
}

export async function listCrptReadQueries(limit = 100) {
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const rows = await queryServerDatabase<CrptReadQueryRow>(
    `
      SELECT ${SAFE_COLUMNS}
      FROM getomerch_marking.crpt_query_safe
      ORDER BY created_at DESC, id DESC
      LIMIT $1
    `,
    [safeLimit],
  );
  return rows.rows.map(mapQuery);
}

function mapQuery(row: CrptReadQueryRow): CrptReadQuery {
  return {
    id: row.id,
    queryType: row.query_type,
    markingCodeId: row.marking_code_id,
    fingerprint: row.fingerprint,
    gtin: row.gtin_snapshot,
    externalDocumentId: row.external_document_id,
    productGroup: row.product_group,
    status: row.status,
    normalizedStatus: row.normalized_status,
    rawStatus: row.raw_status,
    result: row.result_redacted ?? {},
    errorCode: row.error_code,
    errorMessage: row.error_message,
    ownerMatches: row.owner_matches,
    gtinMatches: row.gtin_matches,
    requestedBy: row.requested_by,
    requestId: row.request_id,
    attemptCount: Number(row.attempt_count),
    checkedAt: iso(row.checked_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function iso(value: Date | string | null) {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
