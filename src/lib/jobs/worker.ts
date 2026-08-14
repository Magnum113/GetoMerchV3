import "server-only";

import { hostname } from "node:os";
import { closeServerDatabasePool } from "@/lib/db/pool";
import { applyOzonImportRun } from "@/lib/db/mutations/sync-import";
import type { JobExecutionContext } from "@/lib/jobs/execution";
import {
  claimNextJob,
  completeJob,
  failJob,
  heartbeatJob,
  pruneFinishedJobs,
  recoverStaleJobs,
  updateJobProgress,
} from "@/lib/jobs/queue";
import { CORE_JOB_TYPES, type BackgroundJob } from "@/lib/jobs/types";
import { isRetryableOzonError } from "@/lib/ozon/client";
import { executeImportPreview } from "@/lib/ozon/import-server";
import { executeFinanceSync } from "@/lib/ozon/sync-finance";
import { executeOrdersSync } from "@/lib/ozon/sync-orders";
import { executePricesSync } from "@/lib/ozon/sync-prices";
import { parseOzonImportSelection } from "@/lib/ozon/import-selection";
import { assertAdminWritesEnabled } from "@/lib/admin/maintenance";

export async function runBackgroundWorker() {
  assertAdminWritesEnabled();
  const workerId = `${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  const pollMs = readIntegerEnv("GETOMERCH_WORKER_POLL_MS", 2_000, 250, 30_000);
  const heartbeatMs = readIntegerEnv("GETOMERCH_WORKER_HEARTBEAT_MS", 10_000, 2_000, 60_000);
  const staleSeconds = readIntegerEnv("GETOMERCH_WORKER_STALE_SECONDS", 120, 30, 3_600);
  const retentionDays = readIntegerEnv("GETOMERCH_JOB_RETENTION_DAYS", 30, 7, 3_650);
  const recoveryIntervalMs = Math.max(15_000, Math.min(60_000, staleSeconds * 500));
  let stopping = false;
  let activeAbort: AbortController | null = null;
  let nextRecoveryAt = Date.now() + recoveryIntervalMs;

  const stop = () => {
    stopping = true;
    activeAbort?.abort(new WorkerStoppingError());
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  console.log("[worker] started", { workerId, pollMs, heartbeatMs });
  const recovered = await recoverStaleJobs(staleSeconds);
  const pruned = await pruneFinishedJobs(retentionDays);
  console.log("[worker] maintenance", { recovered: recovered.length, pruned });

  try {
    while (!stopping) {
      const job = await claimNextJob(workerId, [...CORE_JOB_TYPES]);
      if (!job) {
        if (Date.now() >= nextRecoveryAt) {
          const idleRecovered = await recoverStaleJobs(staleSeconds);
          if (idleRecovered.length > 0) {
            console.warn("[worker] recovered stale jobs", { recovered: idleRecovered.length });
          }
          nextRecoveryAt = Date.now() + recoveryIntervalMs;
        }
        await sleep(pollMs);
        continue;
      }

      activeAbort = new AbortController();
      await executeClaimedJob(job, workerId, activeAbort, heartbeatMs);
      activeAbort = null;
    }
  } finally {
    await closeServerDatabasePool();
    console.log("[worker] stopped", { workerId });
  }
}

async function executeClaimedJob(
  job: BackgroundJob,
  workerId: string,
  controller: AbortController,
  heartbeatMs: number,
) {
  let heartbeatRunning = false;
  let progressChain = Promise.resolve();
  const timer = setInterval(() => {
    if (heartbeatRunning || controller.signal.aborted) return;
    heartbeatRunning = true;
    heartbeatJob(job.id, workerId)
      .then((cancelRequested) => {
        if (cancelRequested) controller.abort(new JobCancelledError("Job cancellation requested"));
      })
      .catch((error) => controller.abort(error))
      .finally(() => { heartbeatRunning = false; });
  }, heartbeatMs);

  const context: JobExecutionContext = {
    job,
    signal: controller.signal,
    report: (progress, event) => {
      progressChain = progressChain.then(() => updateJobProgress(job.id, workerId, progress, event));
      return progressChain;
    },
  };

  try {
    const result = await dispatchJob(context);
    await progressChain;
    if (controller.signal.aborted) throw controller.signal.reason;
    await completeJob(job.id, workerId, result);
    console.log("[worker] job succeeded", { jobId: job.id, type: job.type });
  } catch (error) {
    await progressChain.catch(() => undefined);
    const cancelled = error instanceof JobCancelledError;
    const retryable = !cancelled && (error instanceof WorkerStoppingError || isRetryableOzonError(error));
    const state = await failJob(job.id, workerId, error, retryable);
    console.error("[worker] job did not complete", {
      jobId: job.id,
      type: job.type,
      status: state.status,
      code: state.errorCode,
    });
  } finally {
    clearInterval(timer);
  }
}

async function dispatchJob(context: JobExecutionContext) {
  switch (context.job.type) {
    case "ozon_orders_sync":
      validateOrdersPayload(context.job.payload);
      return executeOrdersSync(context);
    case "ozon_finance_sync":
      validateFinancePayload(context.job.payload);
      return executeFinanceSync(context);
    case "ozon_prices_sync":
      validateDryRunPayload(context.job.payload);
      return executePricesSync(context);
    case "ozon_import_preview":
      if (Object.keys(context.job.payload).length !== 0) throw new Error("Invalid import preview payload");
      return executeImportPreview(context);
    case "ozon_import_apply": {
      const runId = stringPayload(context.job.payload.runId, "runId");
      if (!isUuid(runId)) throw new Error("Invalid runId");
      const designOverrides = objectPayload(context.job.payload.designOverrides);
      const selection = parseOzonImportSelection(context.job.payload.selection);
      await context.report({ phase: "apply", runId }, "import_apply_started");
      return applyOzonImportRun(
        {
          actor: context.job.actor,
          sessionId: `job:${context.job.id}`,
          requestId: context.job.requestId,
          idempotencyKey: `${context.job.id}:import:${runId}`,
        },
        runId,
        designOverrides as Record<string, { name?: string; imageUrl?: string | null }>,
        selection,
      );
    }
  }
}

function validateOrdersPayload(payload: Record<string, unknown>) {
  if (payload.scope !== "active" && payload.scope !== "all") throw new Error("Invalid orders sync scope");
  if (!Number.isSafeInteger(payload.days) || Number(payload.days) < 1 || Number(payload.days) > 180) {
    throw new Error("Invalid orders sync days");
  }
  validateDryRunPayload(payload, ["scope", "days", "dryRun"]);
}

function validateFinancePayload(payload: Record<string, unknown>) {
  const from = typeof payload.from === "string" ? new Date(payload.from) : null;
  const to = typeof payload.to === "string" ? new Date(payload.to) : null;
  if (!from || !to || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    throw new Error("Invalid finance sync range");
  }
  validateDryRunPayload(payload, ["from", "to", "dryRun"]);
}

function validateDryRunPayload(payload: Record<string, unknown>, allowedKeys = ["dryRun"]) {
  if (typeof payload.dryRun !== "boolean") throw new Error("Invalid dryRun payload");
  if (Object.keys(payload).some((key) => !allowedKeys.includes(key))) throw new Error("Invalid job payload fields");
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

class JobCancelledError extends Error {
  readonly code = "job_cancelled";

  constructor(message: string) {
    super(message);
    this.name = "JobCancelledError";
  }
}

class WorkerStoppingError extends Error {
  readonly code = "worker_stopping";

  constructor() {
    super("Worker is stopping");
    this.name = "WorkerStoppingError";
  }
}

function stringPayload(value: unknown, name: string) {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function objectPayload(value: unknown) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid job payload");
  return value as Record<string, unknown>;
}

function readIntegerEnv(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
