import "server-only";

import { hostname } from "node:os";
import { assertAdminWritesEnabled } from "@/lib/admin/maintenance";
import { closeServerDatabasePool, queryServerDatabase } from "@/lib/db/pool";
import type { JobExecutionContext } from "@/lib/jobs/execution";
import {
  claimNextJob,
  completeJob,
  failJob,
  heartbeatJob,
  recoverStaleJobs,
  updateJobProgress,
} from "@/lib/jobs/queue";
import type { BackgroundJob, MarkingJobType } from "@/lib/jobs/types";
import { getMarkingRuntimeConfig } from "@/lib/marking/config";
import {
  executeCrptAuthRefresh,
  executeCrptReadQuery,
  isRetryableCrptError,
} from "@/lib/marking/services/crpt-read-execution";
import {
  executeCrptApplicationConfirmation,
  executeCrptIntroductionReconciliation,
  executeCrptIntroductionPoll,
  executeCrptIntroductionSubmit,
} from "@/lib/marking/services/crpt-introduction-execution";
import {
  executeCrptWithdrawalPoll,
  executeCrptWithdrawalSubmit,
} from "@/lib/marking/services/crpt-withdrawal-execution";
import {
  executeCrptReturnPoll,
  executeCrptReturnSubmit,
} from "@/lib/marking/services/crpt-return-execution";
import { executeOzonReturnsSync } from "@/lib/marking/services/ozon-returns-execution";
import {
  getMarkingDocumentType,
  recordWithdrawalManualReview,
} from "@/lib/marking/repositories/withdrawals";
import { recordReturnManualReview } from "@/lib/marking/repositories/returns";
import {
  executeOzonExemplarPoll,
  executeOzonExemplarSubmit,
  executeOzonExemplarValidation,
} from "@/lib/marking/services/ozon-exemplar-execution";
import { isRetryableOzonError } from "@/lib/ozon/client";
import {
  executeSuzOrderPoll,
  executeSuzOrderSubmit,
  isRetryableSuzError,
} from "@/lib/marking/services/suz-order-execution";
import { recordSuzManualReview } from "@/lib/marking/repositories/suz-orders";

const STAGE_EIGHT_JOB_TYPES = [
  "marking_ozon_validate",
  "marking_ozon_submit",
  "marking_ozon_poll",
] as const satisfies readonly MarkingJobType[];

const STAGE_NINE_JOB_TYPES = [
  "marking_crpt_auth_refresh",
  "marking_crpt_code_status_sync",
  "marking_crpt_document_poll",
] as const satisfies readonly MarkingJobType[];

const STAGE_TEN_JOB_TYPES = [
  "marking_crpt_application_submit",
  "marking_crpt_introduction_submit",
] as const satisfies readonly MarkingJobType[];

const STAGE_ELEVEN_JOB_TYPES = [
  "marking_withdrawal_submit",
] as const satisfies readonly MarkingJobType[];

const STAGE_TWELVE_RETURN_JOB_TYPES = [
  "marking_return_to_circulation_submit",
] as const satisfies readonly MarkingJobType[];

const STAGE_TWELVE_OZON_JOB_TYPES = [
  "marking_returns_sync",
] as const satisfies readonly MarkingJobType[];

const STAGE_THIRTEEN_JOB_TYPES = [
  "marking_suz_order_submit",
  "marking_suz_order_poll",
] as const satisfies readonly MarkingJobType[];

export function getActiveMarkingClaimTypes(): readonly MarkingJobType[] {
  const config = getMarkingRuntimeConfig();
  if (!config.enabled) return Object.freeze([]);
  return Object.freeze([
    ...(config.ozonWriteEnabled ? STAGE_EIGHT_JOB_TYPES : []),
    ...(config.crptReadEnabled ? STAGE_NINE_JOB_TYPES : []),
    ...(config.crptIntroductionEnabled ? STAGE_TEN_JOB_TYPES : []),
    ...(config.withdrawalEnabled ? STAGE_ELEVEN_JOB_TYPES : []),
    ...(config.returnsEnabled ? STAGE_TWELVE_RETURN_JOB_TYPES : []),
    ...(config.ozonReturnsSyncEnabled ? STAGE_TWELVE_OZON_JOB_TYPES : []),
    ...(config.suzWriteEnabled ? STAGE_THIRTEEN_JOB_TYPES : []),
  ]);
}

// Kept for the Stage 1 security regression check; with all rollout flags off
// it must still expose no claimable marking jobs.
export const getStageOneMarkingClaimTypes = getActiveMarkingClaimTypes;

export async function runMarkingWorker() {
  assertAdminWritesEnabled();
  const claimTypes = [...getActiveMarkingClaimTypes()];
  const workerId = `${hostname()}:${process.pid}:marking:${crypto.randomUUID().slice(0, 8)}`;
  const pollMs = readIntegerEnv("GETOMERCH_MARKING_WORKER_POLL_MS", 5_000, 1_000, 60_000);
  const heartbeatMs = readIntegerEnv("GETOMERCH_MARKING_WORKER_HEARTBEAT_MS", 10_000, 2_000, 60_000);
  const staleSeconds = readIntegerEnv("GETOMERCH_MARKING_WORKER_STALE_SECONDS", 180, 30, 3_600);
  let stopping = false;
  let activeAbort: AbortController | null = null;
  const stop = () => {
    stopping = true;
    activeAbort?.abort(new WorkerStoppingError());
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  console.log("[marking-worker] started", {
    workerId,
    activeClaimTypes: claimTypes.length,
  });
  if (claimTypes.length > 0) {
    const recovered = await recoverStaleJobs(staleSeconds, { scope: "marking" });
    for (const job of recovered) {
      if (job.status === "failed") await reconcileTerminalWithdrawalFailure(job);
    }
  }
  try {
    while (!stopping) {
      if (claimTypes.length === 0) {
        await sleep(pollMs);
        continue;
      }
      const job = await claimNextJob(workerId, claimTypes, { scope: "marking" });
      if (!job) {
        await sleep(pollMs);
        continue;
      }
      activeAbort = new AbortController();
      await executeClaimedJob(job, workerId, activeAbort, heartbeatMs);
      activeAbort = null;
    }
  } finally {
    await closeServerDatabasePool();
    console.log("[marking-worker] stopped", { workerId });
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
    heartbeatJob(job.id, workerId, { scope: "marking" })
      .then((cancelRequested) => {
        if (cancelRequested) controller.abort(new JobCancelledError());
      })
      .catch((error) => controller.abort(error))
      .finally(() => { heartbeatRunning = false; });
  }, heartbeatMs);
  const context: JobExecutionContext = {
    job,
    signal: controller.signal,
    report: (progress, event) => {
      progressChain = progressChain.then(() => updateJobProgress(
        job.id,
        workerId,
        progress,
        event,
        { scope: "marking" },
      ));
      return progressChain;
    },
  };
  try {
    const result = await dispatchMarkingJob(context);
    await progressChain;
    if (controller.signal.aborted) throw controller.signal.reason;
    await completeJob(job.id, workerId, result, { scope: "marking" });
    console.log("[marking-worker] job succeeded", { jobId: job.id, type: job.type });
  } catch (error) {
    await progressChain.catch(() => undefined);
    const cancelled = error instanceof JobCancelledError;
    const retryable = !cancelled
      && (
        error instanceof WorkerStoppingError
        || isRetryableOzonError(error)
        || isRetryableCrptError(error)
        || isRetryableSuzError(error)
      );
    const state = await failJob(job.id, workerId, error, retryable, {
      scope: "marking",
    });
    if (state.status === "failed") await reconcileTerminalWithdrawalFailure(state);
    console.error("[marking-worker] job did not complete", {
      jobId: job.id,
      type: job.type,
      status: state.status,
      code: state.errorCode,
    });
  } finally {
    clearInterval(timer);
  }
}

export async function dispatchMarkingJob(context: JobExecutionContext) {
  switch (context.job.type) {
    case "marking_crpt_auth_refresh":
      return executeCrptAuthRefresh(context);
    case "marking_crpt_code_status_sync":
      return executeCrptReadQuery(context);
    case "marking_crpt_document_poll": {
      if ("reconcileDocumentId" in context.job.payload) {
        return executeCrptIntroductionReconciliation(context);
      }
      if (!("documentId" in context.job.payload)) return executeCrptReadQuery(context);
      const documentType = await getMarkingDocumentType(
        queryServerDatabase,
        String(context.job.payload.documentId),
      );
      if (documentType === "withdrawal_remote_sale") {
        return executeCrptWithdrawalPoll(context);
      }
      if (documentType === "return_to_circulation") {
        return executeCrptReturnPoll(context);
      }
      return executeCrptIntroductionPoll(context);
    }
    case "marking_crpt_application_submit":
      return executeCrptApplicationConfirmation(context);
    case "marking_crpt_introduction_submit":
      return executeCrptIntroductionSubmit(context);
    case "marking_withdrawal_submit":
      return executeCrptWithdrawalSubmit(context);
    case "marking_return_to_circulation_submit":
      return executeCrptReturnSubmit(context);
    case "marking_returns_sync":
      return executeOzonReturnsSync(context);
    case "marking_ozon_validate":
      return executeOzonExemplarValidation(context);
    case "marking_ozon_submit":
      return executeOzonExemplarSubmit(context);
    case "marking_ozon_poll":
      return executeOzonExemplarPoll(context);
    case "marking_suz_order_submit":
      return executeSuzOrderSubmit(context);
    case "marking_suz_order_poll":
      return executeSuzOrderPoll(context);
    default:
      throw new Error(`Unsupported marking job type: ${context.job.type}`);
  }
}

async function reconcileTerminalWithdrawalFailure(job: BackgroundJob) {
  try {
    if (job.type === "marking_suz_order_submit" || job.type === "marking_suz_order_poll") {
      const orderId = typeof job.payload.orderId === "string" ? job.payload.orderId : null;
      if (!orderId) return;
      await recordSuzManualReview(queryServerDatabase, {
        orderId,
        errorCode: job.errorCode ?? "suz_job_failed",
        errorMessage: job.errorMessage ?? "Задание СУЗ завершилось с ошибкой",
        reason: "Автоматическая обработка остановлена после исчерпания попыток",
      });
      return;
    }
    if (job.type !== "marking_withdrawal_submit"
        && job.type !== "marking_return_to_circulation_submit"
        && job.type !== "marking_crpt_document_poll") return;
    const documentId = typeof job.payload.documentId === "string"
      ? job.payload.documentId : null;
    if (!documentId) return;
    const documentType = await getMarkingDocumentType(
      queryServerDatabase,
      documentId,
    );
    if (documentType === "withdrawal_remote_sale") {
      await recordWithdrawalManualReview(queryServerDatabase, {
        documentId,
        errorCode: job.errorCode ?? "withdrawal_job_failed",
        errorMessage: job.errorMessage ?? "Задание вывода из оборота завершилось с ошибкой",
        phase: "worker_terminal_failure",
      });
    } else if (documentType === "return_to_circulation") {
      await recordReturnManualReview(queryServerDatabase, {
        documentId,
        errorCode: job.errorCode ?? "return_job_failed",
        errorMessage: job.errorMessage ?? "Задание LP_RETURN завершилось с ошибкой",
        phase: "worker_terminal_failure",
      });
    }
  } catch {
    console.error("[marking-worker] failed to reconcile terminal withdrawal", {
      jobId: job.id,
    });
  }
}

class JobCancelledError extends Error {
  readonly code = "job_cancelled";
  constructor() {
    super("Marking job cancellation requested");
    this.name = "JobCancelledError";
  }
}

class WorkerStoppingError extends Error {
  readonly code = "worker_stopping";
  constructor() {
    super("Marking worker is stopping");
    this.name = "WorkerStoppingError";
  }
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
