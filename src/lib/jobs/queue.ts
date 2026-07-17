import "server-only";

import { createHash } from "node:crypto";
import { DatabaseBusinessError } from "@/lib/db/errors";
import { queryServerDatabase, type DatabaseQueryExecutor } from "@/lib/db/pool";
import { withServerDatabaseTransaction } from "@/lib/db/transaction";
import {
  JOB_TYPES,
  type BackgroundJob,
  type EnqueueJobInput,
  type JobEvent,
  type JobStatus,
  type JobType,
  type JobWithEvents,
} from "@/lib/jobs/types";
import { assertAdminWritesEnabled } from "@/lib/admin/maintenance";

type JobRow = {
  id: string;
  type: JobType;
  status: JobStatus;
  dedupe_key: string;
  request_hash: string;
  payload: Record<string, unknown>;
  result: unknown;
  progress: Record<string, unknown>;
  actor: string;
  request_id: string;
  attempt_count: number;
  max_attempts: number;
  available_at: Date | string;
  locked_by: string | null;
  heartbeat_at: Date | string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  cancel_requested_at: Date | string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const JOB_COLUMNS = `
  id, type, status, dedupe_key, request_hash, payload, result, progress,
  actor, request_id, attempt_count, max_attempts, available_at, locked_by,
  heartbeat_at, started_at, finished_at, cancel_requested_at, error_code,
  error_message, created_at, updated_at
`;

export async function enqueueJob(input: EnqueueJobInput) {
  assertAdminWritesEnabled();
  validateEnqueueInput(input);
  const payload = input.payload ?? {};
  const requestHash = digest({ type: input.type, dedupeKey: input.dedupeKey, payload });

  return withServerDatabaseTransaction(async (query) => {
    await advisoryLock(query, `job-idempotency:${input.idempotencyKey}`);
    const existingByRequest = await selectByIdempotency(query, input.idempotencyKey);
    if (existingByRequest) {
      if (existingByRequest.request_hash !== requestHash) {
        throw new DatabaseBusinessError(
          "job_idempotency_conflict",
          "Ключ запуска уже использован с другими параметрами.",
        );
      }
      return { job: mapJob(existingByRequest), reused: true };
    }

    await advisoryLock(query, `job-dedupe:${input.type}:${input.dedupeKey}`);
    const active = (
      await query<JobRow>(
        `
          SELECT ${JOB_COLUMNS}
          FROM getomerch_jobs.jobs
          WHERE type = $1 AND dedupe_key = $2
            AND status = ANY (ARRAY['queued'::text, 'running'::text])
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE
        `,
        [input.type, input.dedupeKey],
      )
    ).rows[0];
    if (active) return { job: mapJob(active), reused: true };

    const job = (
      await query<JobRow>(
        `
          INSERT INTO getomerch_jobs.jobs (
            type, dedupe_key, idempotency_key, request_hash, payload,
            actor, request_id, max_attempts
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::uuid, $8)
          RETURNING ${JOB_COLUMNS}
        `,
        [
          input.type,
          input.dedupeKey,
          input.idempotencyKey,
          requestHash,
          JSON.stringify(payload),
          input.actor,
          input.requestId,
          input.maxAttempts ?? 3,
        ],
      )
    ).rows[0];
    await insertEvent(query, job.id, "info", "queued", { type: job.type });
    return { job: mapJob(job), reused: false };
  });
}

export async function getJob(jobId: string): Promise<JobWithEvents | null> {
  const job = (
    await queryServerDatabase<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM getomerch_jobs.jobs WHERE id = $1::uuid`,
      [jobId],
    )
  ).rows[0];
  if (!job) return null;
  const events = await queryServerDatabase<{
    id: number;
    level: JobEvent["level"];
    event: string;
    details: Record<string, unknown>;
    created_at: Date | string;
  }>(
    `
      SELECT id, level, event, details, created_at
      FROM getomerch_jobs.job_events
      WHERE job_id = $1::uuid
      ORDER BY id DESC
      LIMIT 100
    `,
    [jobId],
  );
  return {
    ...mapJob(job),
    events: events.rows.reverse().map((event) => ({
      id: Number(event.id),
      level: event.level,
      event: event.event,
      details: event.details ?? {},
      createdAt: iso(event.created_at)!,
    })),
  };
}

export async function listJobs(limit = 50): Promise<BackgroundJob[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const rows = await queryServerDatabase<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM getomerch_jobs.jobs ORDER BY created_at DESC LIMIT $1`,
    [safeLimit],
  );
  return rows.rows.map(mapJob);
}

export async function cancelJob(jobId: string, actor: string) {
  assertAdminWritesEnabled();
  return withServerDatabaseTransaction(async (query) => {
    const job = (
      await query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM getomerch_jobs.jobs WHERE id = $1::uuid FOR UPDATE`,
        [jobId],
      )
    ).rows[0];
    if (!job) return null;
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return mapJob(job);

    const nextStatus = job.status === "queued" ? "cancelled" : job.status;
    const updated = (
      await query<JobRow>(
        `
          UPDATE getomerch_jobs.jobs
          SET status = $2,
              cancel_requested_at = COALESCE(cancel_requested_at, clock_timestamp()),
              finished_at = CASE WHEN $2 = 'cancelled' THEN clock_timestamp() ELSE finished_at END,
              updated_at = clock_timestamp()
          WHERE id = $1::uuid
          RETURNING ${JOB_COLUMNS}
        `,
        [jobId, nextStatus],
      )
    ).rows[0];
    await insertEvent(query, jobId, "warning", "cancel_requested", { actor });
    return mapJob(updated);
  });
}

export async function claimNextJob(workerId: string, types: JobType[] = [...JOB_TYPES]) {
  return withServerDatabaseTransaction(async (query) => {
    const candidate = (
      await query<{ id: string }>(
        `
          SELECT id
          FROM getomerch_jobs.jobs
          WHERE status = 'queued'
            AND available_at <= clock_timestamp()
            AND cancel_requested_at IS NULL
            AND attempt_count < max_attempts
            AND type = ANY ($1::text[])
          ORDER BY available_at, created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `,
        [types],
      )
    ).rows[0];
    if (!candidate) return null;

    const job = (
      await query<JobRow>(
        `
          UPDATE getomerch_jobs.jobs
          SET status = 'running',
              attempt_count = attempt_count + 1,
              locked_by = $2,
              locked_at = clock_timestamp(),
              heartbeat_at = clock_timestamp(),
              started_at = COALESCE(started_at, clock_timestamp()),
              error_code = NULL,
              error_message = NULL,
              updated_at = clock_timestamp()
          WHERE id = $1::uuid
          RETURNING ${JOB_COLUMNS}
        `,
        [candidate.id, workerId],
      )
    ).rows[0];
    await insertEvent(query, job.id, "info", "started", {
      workerId,
      attempt: job.attempt_count,
    });
    return mapJob(job);
  });
}

export async function updateJobProgress(
  jobId: string,
  workerId: string,
  progress: Record<string, unknown>,
  event?: string,
) {
  await withServerDatabaseTransaction(async (query) => {
    const updated = await query<{ id: string }>(
      `
        UPDATE getomerch_jobs.jobs
        SET progress = $3::jsonb, heartbeat_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = $1::uuid AND status = 'running' AND locked_by = $2
        RETURNING id
      `,
      [jobId, workerId, JSON.stringify(progress)],
    );
    if (updated.rowCount !== 1) throw lostJobLock();
    if (event) await insertEvent(query, jobId, "info", event, progress);
  });
}

export async function heartbeatJob(jobId: string, workerId: string) {
  const updated = await queryServerDatabase<{ cancel_requested_at: Date | string | null }>(
    `
      UPDATE getomerch_jobs.jobs
      SET heartbeat_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = $1::uuid AND status = 'running' AND locked_by = $2
      RETURNING cancel_requested_at
    `,
    [jobId, workerId],
  );
  if (updated.rowCount !== 1) throw lostJobLock();
  return updated.rows[0].cancel_requested_at !== null;
}

export async function completeJob(jobId: string, workerId: string, result: unknown) {
  await withServerDatabaseTransaction(async (query) => {
    const updated = await query<{ id: string }>(
      `
        UPDATE getomerch_jobs.jobs
        SET status = 'succeeded', result = $3::jsonb, progress = $3::jsonb,
            finished_at = clock_timestamp(), heartbeat_at = clock_timestamp(),
            locked_by = NULL, locked_at = NULL, updated_at = clock_timestamp()
        WHERE id = $1::uuid AND status = 'running' AND locked_by = $2
          AND cancel_requested_at IS NULL
        RETURNING id
      `,
      [jobId, workerId, JSON.stringify(result ?? null)],
    );
    if (updated.rowCount !== 1) throw lostJobLock();
    await insertEvent(query, jobId, "info", "succeeded", summaryDetails(result));
  });
}

export async function failJob(
  jobId: string,
  workerId: string,
  error: unknown,
  retryable: boolean,
) {
  return withServerDatabaseTransaction(async (query) => {
    const current = (
      await query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM getomerch_jobs.jobs WHERE id = $1::uuid FOR UPDATE`,
        [jobId],
      )
    ).rows[0];
    if (!current || current.status !== "running" || current.locked_by !== workerId) {
      throw lostJobLock();
    }

    const cancelled = current.cancel_requested_at !== null;
    const willRetry = !cancelled && retryable && current.attempt_count < current.max_attempts;
    const status: JobStatus = cancelled ? "cancelled" : willRetry ? "queued" : "failed";
    const delaySeconds = Math.min(300, 5 * 3 ** Math.max(0, current.attempt_count - 1));
    const safe = safeJobError(error);
    const updated = (
      await query<JobRow>(
        `
          UPDATE getomerch_jobs.jobs
          SET status = $3,
              available_at = CASE WHEN $3 = 'queued'
                THEN clock_timestamp() + make_interval(secs => $4)
                ELSE available_at
              END,
              finished_at = CASE WHEN $3 = 'queued' THEN NULL ELSE clock_timestamp() END,
              locked_by = NULL,
              locked_at = NULL,
              heartbeat_at = clock_timestamp(),
              error_code = $5,
              error_message = $6,
              updated_at = clock_timestamp()
          WHERE id = $1::uuid AND locked_by = $2
          RETURNING ${JOB_COLUMNS}
        `,
        [jobId, workerId, status, delaySeconds, safe.code, safe.message],
      )
    ).rows[0];
    await insertEvent(
      query,
      jobId,
      willRetry ? "warning" : "error",
      cancelled ? "cancelled" : willRetry ? "retry_scheduled" : "failed",
      { code: safe.code, attempt: current.attempt_count, delaySeconds: willRetry ? delaySeconds : 0 },
    );
    return mapJob(updated);
  });
}

export async function recoverStaleJobs(staleAfterSeconds = 120) {
  const seconds = Math.max(30, Math.min(3600, Math.trunc(staleAfterSeconds)));
  return withServerDatabaseTransaction(async (query) => {
    const rows = await query<JobRow>(
      `
        UPDATE getomerch_jobs.jobs
        SET status = CASE
              WHEN cancel_requested_at IS NOT NULL THEN 'cancelled'
              WHEN attempt_count < max_attempts THEN 'queued'
              ELSE 'failed'
            END,
            available_at = clock_timestamp(),
            finished_at = CASE
              WHEN cancel_requested_at IS NOT NULL OR attempt_count >= max_attempts
                THEN clock_timestamp()
              ELSE NULL
            END,
            locked_by = NULL,
            locked_at = NULL,
            error_code = 'worker_heartbeat_stale',
            error_message = 'Worker heartbeat expired',
            updated_at = clock_timestamp()
        WHERE status = 'running'
          AND COALESCE(heartbeat_at, locked_at, started_at, created_at)
            < clock_timestamp() - make_interval(secs => $1)
        RETURNING ${JOB_COLUMNS}
      `,
      [seconds],
    );
    for (const row of rows.rows) {
      await insertEvent(
        query,
        row.id,
        row.status === "queued" ? "warning" : "error",
        row.status === "queued" ? "stale_requeued" : "stale_failed",
        { attempt: row.attempt_count },
      );
    }
    return rows.rows.map(mapJob);
  });
}

export async function pruneFinishedJobs(retentionDays = 30, batchLimit = 500) {
  const days = Math.max(7, Math.min(3650, Math.trunc(retentionDays)));
  const limit = Math.max(1, Math.min(5000, Math.trunc(batchLimit)));
  const result = await queryServerDatabase<{ deleted_count: number }>(
    "SELECT getomerch_jobs.prune_finished_jobs(make_interval(days => $1), $2) AS deleted_count",
    [days, limit],
  );
  return Number(result.rows[0]?.deleted_count ?? 0);
}

export function isJobType(value: unknown): value is JobType {
  return typeof value === "string" && (JOB_TYPES as readonly string[]).includes(value);
}

function validateEnqueueInput(input: EnqueueJobInput) {
  if (!isJobType(input.type)) throw new DatabaseBusinessError("invalid_job_type", "Неизвестный тип задания.", 400);
  if (input.dedupeKey.length < 1 || input.dedupeKey.length > 300) {
    throw new DatabaseBusinessError("invalid_job_dedupe_key", "Некорректный ключ синхронизации.", 400);
  }
  if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) {
    throw new DatabaseBusinessError("invalid_job_idempotency_key", "Некорректный ключ запуска.", 400);
  }
  if (!/^[0-9a-f-]{36}$/i.test(input.requestId)) {
    throw new DatabaseBusinessError("invalid_job_request_id", "Некорректный request ID.", 400);
  }
  const attempts = input.maxAttempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new DatabaseBusinessError("invalid_job_attempts", "Некорректное число попыток.", 400);
  }
}

async function selectByIdempotency(query: DatabaseQueryExecutor, idempotencyKey: string) {
  return (
    await query<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM getomerch_jobs.jobs WHERE idempotency_key = $1 FOR UPDATE`,
      [idempotencyKey],
    )
  ).rows[0];
}

async function advisoryLock(query: DatabaseQueryExecutor, key: string) {
  await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

async function insertEvent(
  query: DatabaseQueryExecutor,
  jobId: string,
  level: JobEvent["level"],
  event: string,
  details: Record<string, unknown>,
) {
  await query(
    `
      INSERT INTO getomerch_jobs.job_events (job_id, level, event, details)
      VALUES ($1::uuid, $2, $3, $4::jsonb)
    `,
    [jobId, level, event, JSON.stringify(details)],
  );
}

function mapJob(row: JobRow): BackgroundJob {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    dedupeKey: row.dedupe_key,
    payload: row.payload ?? {},
    result: row.result,
    progress: row.progress ?? {},
    actor: row.actor,
    requestId: row.request_id,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    availableAt: iso(row.available_at)!,
    lockedBy: row.locked_by,
    heartbeatAt: iso(row.heartbeat_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    cancelRequestedAt: iso(row.cancel_requested_at),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

function normalize(value: unknown): unknown {
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

function safeJobError(error: unknown) {
  const source = error as { code?: unknown; message?: unknown } | null;
  const rawCode = typeof source?.code === "string" ? source.code : "job_failed";
  const code = /^[A-Za-z0-9_:-]{2,80}$/.test(rawCode) ? rawCode : "job_failed";
  const rawMessage = error instanceof Error ? error.message : typeof source?.message === "string" ? source.message : String(error);
  return { code, message: rawMessage.replace(/[\r\n\t]+/g, " ").slice(0, 500) };
}

function summaryDetails(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object" || Array.isArray(result)) return {};
  const allowed = ["scope", "fetched", "created", "updated", "total", "unmatchedItems", "runId", "status", "durationMs"];
  return Object.fromEntries(
    allowed
      .filter((key) => key in (result as Record<string, unknown>))
      .map((key) => [key, (result as Record<string, unknown>)[key]]),
  );
}

function lostJobLock() {
  return new DatabaseBusinessError("job_lock_lost", "Worker потерял блокировку задания.");
}
