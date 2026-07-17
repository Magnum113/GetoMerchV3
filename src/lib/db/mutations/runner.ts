import "server-only";

import { createHash } from "node:crypto";
import { DatabaseBusinessError, DatabaseFaultInjectionError } from "@/lib/db/errors";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import { withServerDatabaseTransaction } from "@/lib/db/transaction";
import { assertAdminWritesEnabled } from "@/lib/admin/maintenance";

export type ServerMutationContext = {
  actor: string;
  sessionId: string;
  requestId: string;
  idempotencyKey: string;
  faultAfter?: string;
};

export type MutationAudit = {
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
};

export type MutationOutcome<T> = {
  data: T;
  audit: MutationAudit;
};

type StoredRequest = {
  operation: string;
  request_hash: string;
  status: "in_progress" | "succeeded";
  response: unknown;
};

export async function runServerMutation<T>(options: {
  operation: string;
  payload: unknown;
  context: ServerMutationContext;
  execute: (
    query: DatabaseQueryExecutor,
    checkpoint: (name: string) => void,
  ) => Promise<MutationOutcome<T>>;
}): Promise<T> {
  assertAdminWritesEnabled();
  const { operation, payload, context } = options;
  const requestHash = digest({ operation, payload });

  try {
    return await withServerDatabaseTransaction(async (query) => {
      const claim = await query<{ idempotency_key: string }>(
        `
          INSERT INTO getomerch_audit.operation_requests (
            idempotency_key,
            operation,
            request_hash,
            actor,
            session_id,
            request_id
          )
          VALUES ($1, $2, $3, $4, $5, $6::uuid)
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING idempotency_key
        `,
        [
          context.idempotencyKey,
          operation,
          requestHash,
          context.actor,
          context.sessionId,
          context.requestId,
        ],
      );

      if (claim.rowCount === 0) {
        const existing = (
          await query<StoredRequest>(
            `
              SELECT operation, request_hash, status, response
              FROM getomerch_audit.operation_requests
              WHERE idempotency_key = $1
            `,
            [context.idempotencyKey],
          )
        ).rows[0];
        if (!existing || existing.status !== "succeeded") {
          throw new DatabaseBusinessError(
            "idempotency_in_progress",
            "Операция с этим ключом еще выполняется. Повторите запрос позже.",
          );
        }
        if (existing.operation !== operation || existing.request_hash !== requestHash) {
          throw new DatabaseBusinessError(
            "idempotency_conflict",
            "Ключ повторной операции уже использован с другими параметрами.",
          );
        }
        return existing.response as T;
      }

      const checkpoint = (name: string) => {
        if (
          context.faultAfter === name ||
          context.faultAfter === `${operation}:${name}`
        ) {
          throw new DatabaseFaultInjectionError(name);
        }
      };
      const outcome = await options.execute(query, checkpoint);
      const response = outcome.data === undefined ? null : outcome.data;

      await query(
        `
          INSERT INTO getomerch_audit.audit_log (
            actor,
            session_id,
            operation,
            entity_type,
            entity_id,
            request_id,
            idempotency_key,
            result,
            before_state,
            after_state
          )
          VALUES ($1, $2, $3, $4, $5, $6::uuid, $7, 'succeeded', $8::jsonb, $9::jsonb)
        `,
        [
          context.actor,
          context.sessionId,
          operation,
          outcome.audit.entityType,
          outcome.audit.entityId ?? null,
          context.requestId,
          context.idempotencyKey,
          toJson(outcome.audit.before),
          toJson(outcome.audit.after),
        ],
      );
      await query(
        `
          UPDATE getomerch_audit.operation_requests
          SET status = 'succeeded', response = $2::jsonb, updated_at = clock_timestamp()
          WHERE idempotency_key = $1
        `,
        [context.idempotencyKey, toJson(response)],
      );
      return response as T;
    }, { maxRetries: 2 });
  } catch (error) {
    await recordFailedAudit(operation, context, error);
    throw error;
  }
}

async function recordFailedAudit(
  operation: string,
  context: ServerMutationContext,
  error: unknown,
) {
  await withServerDatabaseTransaction(
    (query) => query(
      `
        INSERT INTO getomerch_audit.audit_log (
          actor,
          session_id,
          operation,
          entity_type,
          request_id,
          idempotency_key,
          result,
          error_code
        )
        VALUES ($1, $2, $3, 'mutation', $4::uuid, $5, 'failed', $6)
      `,
      [
        context.actor,
        context.sessionId,
        operation,
        context.requestId,
        context.idempotencyKey,
        errorCode(error),
      ],
    ),
  ).catch((auditError) => {
    console.error("[database-mutation] failed audit write", {
      operation,
      name: auditError instanceof Error ? auditError.name : "UnknownError",
    });
  });
}

function errorCode(error: unknown) {
  if (error instanceof DatabaseBusinessError) return error.code;
  if (error instanceof DatabaseFaultInjectionError) return "fault_injected";
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === "object" && "code" in current) {
      const code = String((current as { code?: unknown }).code ?? "");
      if (/^[A-Z0-9_]{2,40}$/i.test(code)) return code;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return "mutation_failed";
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

function toJson(value: unknown) {
  return JSON.stringify(value === undefined ? {} : value);
}
